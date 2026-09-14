// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.gratisgis.field.core.database.FieldDatabase
import org.gratisgis.field.core.database.QueueEntity
import org.gratisgis.field.core.engine.FieldEngine
import java.time.Instant
import java.util.UUID

/** What the caller wants queued. Mirrors `FeatureEditInput`. */
data class FeatureEdit(
  val collectionId: String,
  val op: String,
  val dataLayerId: String,
  val layerKey: String,
  val globalId: String,
  val geometry: JsonElement?,
  val properties: JsonObject?,
  val schemaHash: String,
  val ownerUserId: String,
  /** `_observation_id` of the feature as read when the edit was made.
   *  Null for an insert. */
  val baseObservationId: String? = null,
)

sealed interface EnqueueResult {
  data class Queued(val row: QueueEntity) : EnqueueResult
  data class Folded(val row: QueueEntity, val replaced: Int) : EnqueueResult
  data class Annihilated(val replaced: Int) : EnqueueResult
}

/**
 * Queue one field edit, folding it into this feature's outstanding
 * edit when there is one. Mirrors `enqueueEdit` in offline-store.ts:
 * the fold itself is the engine's `queue.foldChain`, the surviving
 * row keeps the oldest row's id and queuedAt, and an insert followed
 * by a delete leaves nothing.
 */
class FeatureQueue(private val db: FieldDatabase, private val engine: FieldEngine) {
  private val json = Json { ignoreUnknownKeys = true }

  suspend fun enqueue(edit: FeatureEdit): EnqueueResult {
    val now = Instant.now().toString()
    val sameFeature = db.queue().forFeature(edit.collectionId, edit.dataLayerId, edit.layerKey, edit.globalId)
    val foldable = sameFeature.filter { row ->
      (row.syncStatus == "pending" || row.syncStatus == "failed") && ownedBy(row, edit.ownerUserId)
    }.sortedBy { it.queuedAt }

    if (foldable.isEmpty()) {
      val row = QueueEntity(
        id = UUID.randomUUID().toString(),
        collectionId = edit.collectionId,
        op = edit.op,
        dataLayerId = edit.dataLayerId,
        layerKey = edit.layerKey,
        globalId = edit.globalId,
        geometryJson = edit.geometry?.takeUnless { it is JsonNull }?.toString(),
        propertiesJson = edit.properties?.toString(),
        queuedAt = now,
        schemaHash = edit.schemaHash,
        syncStatus = "pending",
        failureJson = null,
        lastAttemptAt = null,
        retryCount = null,
        ownerUserId = edit.ownerUserId,
        baseObservationId = edit.baseObservationId,
      )
      db.queue().upsert(row)
      return EnqueueResult.Queued(row)
    }

    val chain = buildJsonArray {
      for (r in foldable) add(foldable(r.op, r.geometryJson?.let(json::parseToJsonElement), r.propertiesJson?.let(json::parseToJsonElement)))
      add(foldable(edit.op, edit.geometry, edit.properties))
    }
    val folded = engine.callOrThrow("queue.foldChain", buildJsonObject { put("chain", chain) }).jsonObject
    val keep = foldable.first()
    val removeIds = foldable.drop(1).map { it.id }

    if (folded["kind"]?.jsonPrimitive?.content == "annihilated") {
      db.queue().replaceChain(edit.collectionId, removeIds + keep.id, null)
      return EnqueueResult.Annihilated(foldable.size)
    }
    val e = folded.getValue("edit").jsonObject
    val next = keep.copy(
      op = e.getValue("op").jsonPrimitive.content,
      geometryJson = e["geometry"]?.takeUnless { it is JsonNull }?.toString(),
      propertiesJson = e["properties"]?.takeUnless { it is JsonNull }?.toString(),
      schemaHash = edit.schemaHash,
      syncStatus = "pending",
      failureJson = null,
      lastAttemptAt = null,
      retryCount = null,
      // The oldest row's base stays: the chain as a whole was captured
      // against the state that row read. An insert chain has none.
      baseObservationId = keep.baseObservationId,
      conflictCurrentJson = null,
    )
    db.queue().replaceChain(edit.collectionId, removeIds, next)
    return EnqueueResult.Folded(next, foldable.size)
  }

  private suspend fun ownedBy(row: QueueEntity, userId: String): Boolean =
    engine.callOrThrow(
      "queue.isOwnedBy",
      buildJsonObject {
        put("row", buildJsonObject { row.ownerUserId?.let { put("ownerUserId", JsonPrimitive(it)) } })
        put("currentUserId", JsonPrimitive(userId))
      },
    ).jsonPrimitive.content.toBoolean()

  private fun foldable(op: String, geometry: JsonElement?, properties: JsonElement?): JsonObject = buildJsonObject {
    put("op", JsonPrimitive(op))
    put("geometry", geometry ?: JsonNull)
    put("properties", properties ?: JsonNull)
  }
}
