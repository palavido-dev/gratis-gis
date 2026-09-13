// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A data_collection the device has taken offline, plus what was
 * fetched with it. Mirrors `CachedDeployment` in offline-store.ts at
 * the level the skeleton needs; the manifest fields (partial reasons,
 * byte counts) come with the full download flow.
 */
@Entity(tableName = "collection")
data class CollectionEntity(
  @PrimaryKey val id: String,
  val title: String,
  val mapId: String,
  /** The item's `data` as sent, for the fields not modelled here. */
  val dataJson: String,
  val downloadedAt: String?,
)

/**
 * One editable sublayer of a collection: the (dataLayerId, layerKey)
 * pair the queue and the feature cache key on, with the schema
 * snapshot that `schemaHash` was computed from.
 */
@Entity(
  tableName = "layer",
  primaryKeys = ["collectionId", "dataLayerId", "layerKey"],
  indices = [Index("collectionId")],
)
data class LayerEntity(
  val collectionId: String,
  val dataLayerId: String,
  val layerKey: String,
  val label: String,
  /** GeoJSON geometry type, or null for a table sublayer. */
  val geometryType: String?,
  /** `FeatureField[]` as JSON, the input to `feature.validate`. */
  val fieldsJson: String,
  val schemaHash: String,
  val editingPolicy: String,
  val addable: Boolean,
  val boundFormItemId: String?,
)

/** A cached feature. `featureJson` is the GeoJSON Feature verbatim. */
@Entity(
  tableName = "feature",
  primaryKeys = ["collectionId", "dataLayerId", "layerKey", "globalId"],
  indices = [Index("collectionId", "dataLayerId", "layerKey")],
)
data class FeatureEntity(
  val collectionId: String,
  val dataLayerId: String,
  val layerKey: String,
  val globalId: String,
  val featureJson: String,
  val cachedAt: String,
)

/** A bound form's schema, fetched with the collection. */
@Entity(tableName = "form")
data class FormEntity(
  @PrimaryKey val id: String,
  val schemaJson: String,
  val requiredEngineVersion: Int?,
  val cachedAt: String,
)

/** A prepared basemap package on disk. */
@Entity(
  tableName = "offline_package",
  primaryKeys = ["collectionId", "areaId"],
)
data class OfflinePackageEntity(
  val collectionId: String,
  val areaId: String,
  val packageId: String,
  val areaName: String,
  /** Absolute path of the .pmtiles file. */
  val filePath: String,
  val sizeBytes: Long,
  val downloadedAt: String,
)

/**
 * A queued edit. Mirrors `QueueRecord` in offline-store.ts field for
 * field, because the engine bundle's `queue.*` functions take this
 * row as JSON and the drain writes back what they return. `id` is the
 * operation's id, not the feature's; see the web type's comment for
 * why that matters.
 */
@Entity(
  tableName = "queue",
  primaryKeys = ["collectionId", "id"],
  indices = [Index("collectionId"), Index("collectionId", "syncStatus")],
)
data class QueueEntity(
  val id: String,
  val collectionId: String,
  /** insert, update, delete. */
  val op: String,
  val dataLayerId: String,
  val layerKey: String,
  val globalId: String,
  /** GeoJSON geometry as JSON text, or null. */
  val geometryJson: String?,
  /** Properties object as JSON text, or null for a delete. */
  val propertiesJson: String?,
  val queuedAt: String,
  val schemaHash: String,
  /** pending, syncing, synced, failed, rejected. */
  val syncStatus: String,
  /** `OfflineMessageEnvelope` as JSON text, or null. */
  val failureJson: String?,
  val lastAttemptAt: String?,
  val retryCount: Int?,
  val ownerUserId: String?,
)
