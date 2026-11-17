// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.gratisgis.field.core.database.AccountScope
import org.gratisgis.field.core.database.FieldDatabase
import org.gratisgis.field.core.database.QueueEntity
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.network.FeatureInsert
import org.gratisgis.field.core.network.InsertFeaturesRequest
import org.gratisgis.field.core.network.PortalClient
import org.gratisgis.field.core.network.PortalError
import java.io.IOException
import java.time.Instant

data class SyncResult(
  val processed: Int = 0,
  val synced: Int = 0,
  val failed: Int = 0,
  val rejected: Int = 0,
  val remaining: Int = 0,
  val errors: List<SyncError> = emptyList(),
)

data class SyncError(val recordId: String, val op: String, val layerKey: String, val reason: JsonObject, val terminal: Boolean)

/**
 * Drain one collection's queue. Mirrors `syncQueue` in
 * apps/portal-web/src/lib/offline-sync.ts step for step:
 *
 *  - `queue.chainHeads` picks at most one row per feature, the oldest,
 *    and only when it is claimable (stale-claim reclaim and the retry
 *    backoff are inside that call).
 *  - The claim is a conditional UPDATE, so two drains cannot both send
 *    the same row.
 *  - Replay through the same routes the web runtime uses.
 *  - `sync.outcome` decides done / retry / rejected from the status.
 *  - A network failure (no response at all) restores the row without
 *    counting an attempt, so an outage does not climb the ladder.
 *  - Once claimed, a row is marked as possibly on the server
 *    (`mayHaveReachedServer`) and stays marked. A marked insert is
 *    looked up on the server before it is sent again.
 *  - Only the signed-in account's rows for this portal are sent.
 *  - A 409 on an update whose `current` already holds the queued
 *    values is this device's own earlier write whose response was
 *    lost (`sync.isOwnEditEcho`): the row is done, not a conflict.
 *  - After an update lands, the same account's later queued rows of
 *    that feature, and its cached copy, move to the head the PATCH
 *    wrote (`FeatureHeadRebase`, web `rebaseFeatureHead`).
 *  - Anything else thrown while replaying one row parks that row as
 *    failed with `sync.unexpected` and the drain moves on, so one bad
 *    row cannot stop the rest or sit in 'syncing'.
 */
class QueueDrain(
  private val db: FieldDatabase,
  private val engine: FieldEngine,
  private val portal: PortalClient,
) {
  private val json = Json { ignoreUnknownKeys = true }

  suspend fun drain(collectionId: String, scope: AccountScope, manual: Boolean): SyncResult {
    val nowMs = System.currentTimeMillis()
    val currentUserId = scope.userId
    // A row queued on another portal is never sent here: the same ids
    // there name different features (a delete would come back 404 and
    // count as done).
    fun mine(row: QueueEntity) = scope.samePortal(row.portal)
    val all = db.queue().forCollection(collectionId).filter { mine(it) && ownedBy(it, currentUserId) }
    val byId = all.associateBy { it.id }
    val heads = engine.callOrThrow(
      "queue.chainHeads",
      buildJsonObject {
        put("rows", buildJsonArray { for (r in all) add(r.toEngineRow(json)) })
        put("nowMs", JsonPrimitive(nowMs))
        put("options", buildJsonObject { put("ignoreBackoff", JsonPrimitive(manual)) })
      },
    ).jsonArray.map { byId.getValue(it.jsonObject.getValue("id").jsonPrimitive.content) }

    var synced = 0
    var failed = 0
    var rejected = 0
    var processed = 0
    val errors = mutableListOf<SyncError>()

    for (record in heads) {
      val attemptAt = Instant.now().toString()
      val claimed = db.queue().claim(collectionId, record.id, record.syncStatus, record.lastAttemptAt, attemptAt) == 1
      if (!claimed) continue
      // `record` was read before the claim; every write-back below keeps
      // the mark the claim set.
      val outcome = replay(record)
      processed += 1
      when (outcome) {
        is Replay.Done -> {
          db.queue().delete(collectionId, record.id)
          synced += 1
          if (outcome.head != null) rebaseAfterUpdate(record, outcome.head)
        }
        is Replay.Unreachable -> {
          // Not the row's fault: restore the pre-claim status and leave
          // the attempt bookkeeping alone.
          // The request may have landed with only the answer lost.
          db.queue().upsert(
            record.copy(
              syncStatus = if (record.syncStatus == "failed") "failed" else "pending",
              mayHaveReachedServer = true,
            ),
          )
          failed += 1
          errors += SyncError(record.id, record.op, record.layerKey, outcome.reason, terminal = false)
        }
        is Replay.Refused -> {
          db.queue().upsert(
            record.copy(
              syncStatus = if (outcome.terminal) "rejected" else "failed",
              mayHaveReachedServer = true,
              failureJson = outcome.reason.toString(),
              retryCount = (record.retryCount ?: 0) + 1,
              lastAttemptAt = Instant.now().toString(),
            ),
          )
          if (outcome.terminal) rejected += 1 else failed += 1
          errors += SyncError(record.id, record.op, record.layerKey, outcome.reason, outcome.terminal)
        }
        is Replay.Conflict -> {
          db.queue().upsert(
            record.copy(
              syncStatus = "rejected",
              mayHaveReachedServer = true,
              failureJson = outcome.reason.toString(),
              conflictCurrentJson = outcome.current.toString(),
              retryCount = (record.retryCount ?: 0) + 1,
              lastAttemptAt = Instant.now().toString(),
            ),
          )
          rejected += 1
          errors += SyncError(record.id, record.op, record.layerKey, outcome.reason, terminal = true)
        }
      }
    }

    val pending = db.queue().byStatus(collectionId, "pending").count { mine(it) && ownedBy(it, currentUserId) }
    val stillFailed = db.queue().byStatus(collectionId, "failed").count { mine(it) && ownedBy(it, currentUserId) }
    val allRejected = db.queue().byStatus(collectionId, "rejected").count { mine(it) && ownedBy(it, currentUserId) }
    return SyncResult(processed, synced, failed, allRejected, pending + stillFailed, errors)
  }

  private sealed interface Replay {
    /** `head` is the `_observation_id` an update just wrote, when the
     *  server named it. */
    data class Done(val head: String? = null) : Replay
    data class Unreachable(val reason: JsonObject) : Replay
    data class Refused(val reason: JsonObject, val terminal: Boolean) : Replay
    /** A 409 from the concurrency guard: parked with the server's
     *  current version attached for the review screen. */
    data class Conflict(val reason: JsonObject, val current: kotlinx.serialization.json.JsonElement) : Replay
  }

  /**
   * Replay one row. Anything this build did not expect (a stored row
   * that no longer parses, an engine call that fails, a response that
   * does not convert) parks the row as failed with the error text, as
   * the web drain does. Not terminal, so a fix on either side lets it
   * through later.
   *
   * The one thing that escapes is the drain itself being cancelled.
   * The edit may have reached the server, so the row is left
   * 'syncing' on purpose: a later edit cannot fold into a 'syncing'
   * row (a correction folded behind an insert that already landed
   * would be lost to the server's dedupe), and the stale-claim rule in
   * `queue.chainHeads` hands it to the next drain.
   */
  private suspend fun replay(r: QueueEntity): Replay =
    try {
      replayOnce(r)
    } catch (t: Throwable) {
      // Rethrows only when this coroutine was cancelled. A
      // CancellationException from inside a call while we are still
      // active is that call failing, and is parked like any other.
      currentCoroutineContext().ensureActive()
      Replay.Refused(message("sync.unexpected", "error" to JsonPrimitive(t.message ?: t.toString())), terminal = false)
    }

  private suspend fun replayOnce(r: QueueEntity): Replay {
    val geometry = r.geometryJson?.let(json::parseToJsonElement)
    val properties = r.propertiesJson?.let { json.parseToJsonElement(it) as? JsonObject } ?: JsonObject(emptyMap())
    return try {
      var head: String? = null
      when (r.op) {
        "insert" -> {
          // An earlier attempt may have created it with only the answer
          // lost. Look first, so a retry does not lean on the server's
          // dedupe to absorb a second create.
          if (r.mayHaveReachedServer && insertLanded(r)) return Replay.Done()
          portal.insertFeatures(
            r.dataLayerId, r.layerKey,
            InsertFeaturesRequest(listOf(FeatureInsert(r.globalId, geometry ?: JsonNull, properties))),
          )
        }
        "update" -> {
          // Dry-run first so a conflict / schema refusal parks the
          // row without applying (mirrors portal-web offline-sync).
          portal.patchFeature(
            r.dataLayerId, r.layerKey, r.globalId, properties, geometry,
            baseObservationId = r.baseObservationId,
            checkOnly = true,
          )
          val written = portal.patchFeature(
            r.dataLayerId, r.layerKey, r.globalId, properties, geometry,
            baseObservationId = r.baseObservationId,
          )
          head = FeatureHeadRebase.headFromResponse(written)
        }
        "delete" -> {
          portal.deleteFeature(
            r.dataLayerId, r.layerKey, r.globalId,
            baseObservationId = r.baseObservationId,
            checkOnly = true,
          )
          portal.deleteFeature(
            r.dataLayerId, r.layerKey, r.globalId,
            baseObservationId = r.baseObservationId,
          )
        }
        else -> return Replay.Refused(message("sync.unknownOp", "op" to JsonPrimitive(r.op)), terminal = true)
      }
      Replay.Done(head)
    } catch (e: PortalError.Conflict) {
      if (e.code == "feature-conflict" && r.op == "update" && isOwnEcho(geometry, properties, e.current)) {
        // The PATCH committed earlier and its response was lost (a
        // timeout in poor coverage), so the head is our own write.
        return Replay.Done()
      }
      if (e.code == "feature-conflict") {
        // Somebody else's edit landed between our read and this replay.
        // Terminal: a person has to look at both versions (screen 3a).
        return Replay.Conflict(
          reason = message("sync.conflict", "serverMessage" to JsonPrimitive(e.message ?: "")),
          current = e.current ?: JsonNull,
        )
      }
      Replay.Refused(message("sync.serverRefused", "serverMessage" to JsonPrimitive(e.message ?: "")), terminal = true)
    } catch (e: PortalError) {
      val outcome = engine.callOrThrow(
        "sync.outcome",
        buildJsonObject { put("status", JsonPrimitive(e.status)); put("op", JsonPrimitive(r.op)) },
      ).jsonPrimitive.content
      when (outcome) {
        "done" -> Replay.Done()
        "rejected" -> Replay.Refused(message("sync.serverRefused", "serverMessage" to JsonPrimitive(e.message ?: "")), terminal = true)
        else -> Replay.Refused(
          message("sync.serverRefusedWithStatus", "serverMessage" to JsonPrimitive(e.message ?: ""), "status" to JsonPrimitive(e.status)),
          terminal = false,
        )
      }
    } catch (e: IOException) {
      Replay.Unreachable(message("sync.networkUnavailableDetail", "error" to JsonPrimitive(e.message ?: e.toString())))
    }
  }

  /**
   * Move the guard of what this device queued on top of `landed` to
   * the head it just wrote. Best effort: the row is already done, and
   * if this fails the worst case is a later edit parked as a conflict
   * for review, which is what happened before this step existed.
   */
  private suspend fun rebaseAfterUpdate(landed: QueueEntity, head: String) {
    try {
      val sameFeature = db.queue().forFeature(landed.collectionId, landed.dataLayerId, landed.layerKey, landed.globalId)
      val before = sameFeature.associateBy { it.id }
      for (row in FeatureHeadRebase.rowsToRebase(landed, sameFeature, head)) {
        // A conditional UPDATE of the base column only, so a row that
        // a drain claimed or an edit folded since the read keeps its
        // content; it moves only if it is still pending / failed with
        // the base we read.
        db.queue().rebase(row.collectionId, row.id, before.getValue(row.id).baseObservationId, head)
      }
      val cached = db.features().get(landed.collectionId, landed.dataLayerId, landed.layerKey, landed.globalId)
      if (cached != null) {
        val next = FeatureHeadRebase.rebasedFeatureJson(cached.featureJson, landed.baseObservationId, head)
        // Compare and set: a newer copy that a download wrote in the
        // meantime is left as it is.
        if (next != null) db.features().replaceJsonIf(cached.collectionId, cached.dataLayerId, cached.layerKey, cached.globalId, cached.featureJson, next)
      }
    } catch (_: Throwable) {
      // See above: leaving the old base is the safe failure. Only a
      // cancelled drain stops here.
      currentCoroutineContext().ensureActive()
    }
  }

  /** Whether the server already holds the feature this insert creates.
   *  A 404 (the layer or the feature is not there) reads as no; any
   *  other failure propagates and is handled like a failed send. */
  private suspend fun insertLanded(r: QueueEntity): Boolean {
    val text = try {
      portal.getFeaturesByEntity(r.dataLayerId, r.layerKey, r.globalId)
    } catch (_: PortalError.NotFound) {
      return false
    }
    val features = (json.parseToJsonElement(text) as? JsonObject)?.get("features") as? kotlinx.serialization.json.JsonArray
    return !features.isNullOrEmpty()
  }

  private suspend fun isOwnEcho(
    geometry: kotlinx.serialization.json.JsonElement?,
    properties: JsonObject,
    current: kotlinx.serialization.json.JsonElement?,
  ): Boolean {
    if (current == null || current is JsonNull) return false
    return engine.callOrThrow(
      "sync.isOwnEditEcho",
      buildJsonObject {
        put(
          "edit",
          buildJsonObject {
            put("op", JsonPrimitive("update"))
            put("geometry", geometry ?: JsonNull)
            put("properties", properties)
          },
        )
        put("current", current)
      },
    ).jsonPrimitive.content.toBoolean()
  }

  private fun message(code: String, vararg params: Pair<String, JsonPrimitive>): JsonObject = buildJsonObject {
    put("code", JsonPrimitive(code))
    if (params.isNotEmpty()) put("params", buildJsonObject { for ((k, v) in params) put(k, v) })
  }

  private suspend fun ownedBy(row: QueueEntity, userId: String): Boolean =
    engine.callOrThrow(
      "queue.isOwnedBy",
      buildJsonObject {
        put("row", buildJsonObject { row.ownerUserId?.let { put("ownerUserId", JsonPrimitive(it)) } })
        put("currentUserId", JsonPrimitive(userId))
      },
    ).jsonPrimitive.content.toBoolean()
}
