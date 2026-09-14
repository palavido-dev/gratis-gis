// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
 */
class QueueDrain(
  private val db: FieldDatabase,
  private val engine: FieldEngine,
  private val portal: PortalClient,
) {
  private val json = Json { ignoreUnknownKeys = true }

  suspend fun drain(collectionId: String, currentUserId: String, manual: Boolean): SyncResult {
    val nowMs = System.currentTimeMillis()
    val all = db.queue().forCollection(collectionId).filter { ownedBy(it, currentUserId) }
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
      val outcome = replay(record)
      processed += 1
      when (outcome) {
        Replay.Done -> {
          db.queue().delete(collectionId, record.id)
          synced += 1
        }
        is Replay.Unreachable -> {
          // Not the row's fault: restore the pre-claim status and leave
          // the attempt bookkeeping alone.
          db.queue().upsert(record.copy(syncStatus = if (record.syncStatus == "failed") "failed" else "pending"))
          failed += 1
          errors += SyncError(record.id, record.op, record.layerKey, outcome.reason, terminal = false)
        }
        is Replay.Refused -> {
          db.queue().upsert(
            record.copy(
              syncStatus = if (outcome.terminal) "rejected" else "failed",
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

    val pending = db.queue().byStatus(collectionId, "pending").count { ownedBy(it, currentUserId) }
    val stillFailed = db.queue().byStatus(collectionId, "failed").count { ownedBy(it, currentUserId) }
    val allRejected = db.queue().byStatus(collectionId, "rejected").count { ownedBy(it, currentUserId) }
    return SyncResult(processed, synced, failed, allRejected, pending + stillFailed, errors)
  }

  private sealed interface Replay {
    data object Done : Replay
    data class Unreachable(val reason: JsonObject) : Replay
    data class Refused(val reason: JsonObject, val terminal: Boolean) : Replay
    /** A 409 from the concurrency guard: parked with the server's
     *  current version attached for the review screen. */
    data class Conflict(val reason: JsonObject, val current: kotlinx.serialization.json.JsonElement) : Replay
  }

  private suspend fun replay(r: QueueEntity): Replay {
    val geometry = r.geometryJson?.let(json::parseToJsonElement)
    val properties = r.propertiesJson?.let { json.parseToJsonElement(it) as? JsonObject } ?: JsonObject(emptyMap())
    return try {
      when (r.op) {
        "insert" -> portal.insertFeatures(
          r.dataLayerId, r.layerKey,
          InsertFeaturesRequest(listOf(FeatureInsert(r.globalId, geometry ?: JsonNull, properties))),
        )
        "update" -> portal.patchFeature(
          r.dataLayerId, r.layerKey, r.globalId, properties, geometry,
          baseObservationId = r.baseObservationId,
        )
        "delete" -> portal.deleteFeature(
          r.dataLayerId, r.layerKey, r.globalId,
          baseObservationId = r.baseObservationId,
        )
        else -> return Replay.Refused(message("sync.unknownOp", "op" to JsonPrimitive(r.op)), terminal = true)
      }
      Replay.Done
    } catch (e: PortalError.Conflict) {
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
        "done" -> Replay.Done
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
