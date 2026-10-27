// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.gratisgis.field.core.database.QueueEntity

/**
 * Live head probe used to pick PATCH / DELETE vs POST recreate.
 * Mirrors `SyncConflictLiveHead` in portal-web.
 */
data class ConflictLiveHead(
  val exists: Boolean,
  /** Current `_observation_id` when the feature is still live. */
  val observationId: String? = null,
)

/**
 * Choose the write that re-applies a rejected Android queue row whose
 * losing side is the queued geometry/properties and whose
 * `conflictCurrentJson` (or a fresh probe) describes the server head.
 *
 * - update + live feature → PATCH with stripped attrs/geometry and
 *   the live `baseObservationId`
 * - update + feature gone → POST recreate (same globalId)
 * - delete + live feature → DELETE with live `baseObservationId`
 * - delete + feature gone → noop (already matches the losing intent)
 */
sealed interface ConflictReapplyPlan {
  data class Patch(
    val featureId: String,
    val properties: JsonObject,
    val geometry: JsonElement?,
    val baseObservationId: String?,
  ) : ConflictReapplyPlan

  data class Delete(
    val featureId: String,
    val baseObservationId: String?,
  ) : ConflictReapplyPlan

  data class Post(
    val globalId: String,
    val properties: JsonObject,
    val geometry: JsonElement?,
  ) : ConflictReapplyPlan

  /** Delete already applied (feature gone); nothing to write. */
  data class Noop(val reason: String) : ConflictReapplyPlan

  data class Unavailable(val reason: String) : ConflictReapplyPlan
}

object ConflictReapply {
  private val json = Json { ignoreUnknownKeys = true }

  /**
   * Drop `_`-prefixed system keys before a re-apply write. The read
   * path inlines `_global_id`, `_observation_id`, etc.; writing them
   * back would freeze stale editor-tracking into attrs.
   */
  fun stripUserProperties(props: JsonObject?): JsonObject {
    if (props == null) return JsonObject(emptyMap())
    return buildJsonObject {
      for ((k, v) in props) {
        if (k.startsWith("_")) continue
        put(k, v)
      }
    }
  }

  /**
   * Parse a parked `conflictCurrentJson` (or a single Feature from a
   * live probe) into a [ConflictLiveHead]. The literal JSON `null`
   * (or blank / missing) means the feature was deleted in between.
   */
  fun liveHeadFromCurrentJson(conflictCurrentJson: String?): ConflictLiveHead {
    if (conflictCurrentJson.isNullOrBlank() || conflictCurrentJson == "null") {
      return ConflictLiveHead(exists = false)
    }
    val parsed = runCatching { json.parseToJsonElement(conflictCurrentJson) }.getOrNull()
      ?: return ConflictLiveHead(exists = false)
    if (parsed is JsonNull) return ConflictLiveHead(exists = false)
    val obj = parsed as? JsonObject ?: return ConflictLiveHead(exists = true)
    val props = obj["properties"] as? JsonObject
    val obs = props?.get("_observation_id")?.jsonPrimitive?.contentOrNull
    return ConflictLiveHead(exists = true, observationId = obs)
  }

  fun plan(row: QueueEntity, live: ConflictLiveHead): ConflictReapplyPlan {
    if (row.op == "delete") {
      if (!live.exists) return ConflictReapplyPlan.Noop(reason = "already-deleted")
      return ConflictReapplyPlan.Delete(
        featureId = row.globalId,
        baseObservationId = live.observationId,
      )
    }

    if (row.op != "update" && row.op != "insert") {
      return ConflictReapplyPlan.Unavailable(reason = "unsupported-op")
    }

    val propertiesRaw = row.propertiesJson?.let {
      runCatching { json.parseToJsonElement(it) as? JsonObject }.getOrNull()
    }
    if (propertiesRaw == null && row.op == "update") {
      return ConflictReapplyPlan.Unavailable(reason = "missing-losing-side")
    }
    val properties = stripUserProperties(propertiesRaw)
    val geometry = row.geometryJson?.let {
      runCatching { json.parseToJsonElement(it) }.getOrNull()?.takeUnless { el -> el is JsonNull }
    }

    if (!live.exists) {
      return ConflictReapplyPlan.Post(
        globalId = row.globalId,
        properties = properties,
        geometry = geometry,
      )
    }

    return ConflictReapplyPlan.Patch(
      featureId = row.globalId,
      properties = properties,
      geometry = geometry,
      baseObservationId = live.observationId,
    )
  }
}
