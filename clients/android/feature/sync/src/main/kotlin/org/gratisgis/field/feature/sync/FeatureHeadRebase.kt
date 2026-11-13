// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.gratisgis.field.core.database.QueueEntity

/**
 * Pure rules for moving a feature's conflict guard forward after a
 * queued update landed. Mirrors `rebaseFeatureHead` in
 * apps/portal-web/src/lib/offline-store.ts. Without it, the next edit
 * of the same feature is sent with the token from before the first
 * sync and the server answers 409 against this device's own write.
 */
object FeatureHeadRebase {
  private val json = Json { ignoreUnknownKeys = true }

  /**
   * The rows to rewrite with `head` as their base: other pending or
   * failed rows of the same feature, owned by the SAME account and
   * queued AFTER `landed`. Those were authored on top of the landed
   * edit. A row another account queued, or one queued earlier, was
   * authored against something else; moving its base would let it
   * overwrite the landed write with no conflict, so it keeps its own.
   * A row with no base (an insert, or a legacy row) stays as it is.
   */
  fun rowsToRebase(landed: QueueEntity, rows: List<QueueEntity>, head: String): List<QueueEntity> {
    val owner = landed.ownerUserId ?: return emptyList()
    return rows.filter { row ->
      row.id != landed.id &&
        row.collectionId == landed.collectionId &&
        row.globalId == landed.globalId &&
        row.dataLayerId == landed.dataLayerId &&
        row.layerKey == landed.layerKey &&
        row.ownerUserId == owner &&
        row.queuedAt > landed.queuedAt &&
        row.baseObservationId != null &&
        (row.syncStatus == "pending" || row.syncStatus == "failed")
    }.map { it.copy(baseObservationId = head) }
  }

  /**
   * The cached feature JSON with `_observation_id` set to `head`, or
   * null to leave it alone. Only moved while the cache still holds the
   * base `landed` was made against (or no token at all): a newer token
   * that already arrived by delta is never moved backwards.
   */
  fun rebasedFeatureJson(featureJson: String, landedBase: String?, head: String): String? {
    val feature = runCatching { json.parseToJsonElement(featureJson) as? JsonObject }.getOrNull() ?: return null
    val props = feature["properties"] as? JsonObject ?: JsonObject(emptyMap())
    val cached = (props["_observation_id"] as? JsonPrimitive)?.contentOrNull
    if (cached != null && cached != landedBase) return null
    if (cached == head) return null
    val nextProps = JsonObject(props + ("_observation_id" to JsonPrimitive(head)))
    return JsonObject(feature + ("properties" to nextProps)).toString()
  }

  /** The `_observation_id` a PATCH response names, if any. */
  fun headFromResponse(body: JsonObject?): String? {
    val props = body?.get("properties") as? JsonObject ?: return null
    return (props["_observation_id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
  }
}
