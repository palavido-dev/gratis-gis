// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.gratisgis.field.core.database.FeatureEntity
import org.gratisgis.field.core.network.LayerDeltaChange

/**
 * Pure apply helpers for `GET .../delta` pages. Mirrors
 * `applyDeltaChanges` in apps/portal-web/src/lib/offline-download.ts:
 * last write per entity wins within a page; `delete` removes the row;
 * create / update / derive / observe upsert a Feature keyed by
 * `entity` (= `_global_id`).
 */
object LayerDeltaApply {
  /** Server max page size; field refresh asks for the max so a single
   *  write rarely truncates mid-syncVersion. */
  const val DELTA_PAGE_LIMIT = 10_000

  data class ApplyResult(
    val upserts: List<FeatureEntity>,
    val deletes: List<String>,
  )

  fun applyDeltaChanges(
    changes: List<LayerDeltaChange>,
    collectionId: String,
    dataLayerId: String,
    layerKey: String,
    cachedAt: String,
  ): ApplyResult {
    val byEntity = LinkedHashMap<String, Entry>()
    for (change in changes) {
      if (change.kind == "delete") {
        byEntity[change.entity] = Entry.Delete
        continue
      }
      val props = buildJsonObject {
        change.properties?.forEach { (k, v) -> put(k, v) }
        put("_global_id", change.entity)
      }
      val feature = buildJsonObject {
        put("type", "Feature")
        put("id", change.entity)
        put("geometry", change.geometry ?: JsonNull)
        put("properties", props)
      }
      byEntity[change.entity] = Entry.Upsert(
        FeatureEntity(
          collectionId = collectionId,
          dataLayerId = dataLayerId,
          layerKey = layerKey,
          globalId = change.entity,
          featureJson = feature.toString(),
          cachedAt = cachedAt,
        ),
      )
    }
    val upserts = mutableListOf<FeatureEntity>()
    val deletes = mutableListOf<String>()
    for ((entity, entry) in byEntity) {
      when (entry) {
        is Entry.Upsert -> upserts += entry.row
        Entry.Delete -> deletes += entity
      }
    }
    return ApplyResult(upserts, deletes)
  }

  private sealed class Entry {
    data class Upsert(val row: FeatureEntity) : Entry()
    data object Delete : Entry()
  }
}
