// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface CollectionDao {
  @Upsert suspend fun upsert(row: CollectionEntity)
  @Query("SELECT * FROM collection WHERE id = :id") suspend fun get(id: String): CollectionEntity?
  @Query("SELECT * FROM collection ORDER BY title") fun observeAll(): Flow<List<CollectionEntity>>
  @Query("DELETE FROM collection WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface LayerDao {
  @Upsert suspend fun upsertAll(rows: List<LayerEntity>)
  @Query("SELECT * FROM layer WHERE collectionId = :collectionId") suspend fun forCollection(collectionId: String): List<LayerEntity>
  @Query("SELECT * FROM layer WHERE collectionId = :collectionId AND dataLayerId = :dataLayerId AND layerKey = :layerKey")
  suspend fun get(collectionId: String, dataLayerId: String, layerKey: String): LayerEntity?
  @Query("DELETE FROM layer WHERE collectionId = :collectionId") suspend fun deleteForCollection(collectionId: String)
}

@Dao
interface FeatureDao {
  @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<FeatureEntity>)
  @Query("SELECT COUNT(*) FROM feature WHERE collectionId = :collectionId") suspend fun countForCollection(collectionId: String): Int
  @Query("SELECT * FROM feature WHERE collectionId = :collectionId AND dataLayerId = :dataLayerId AND layerKey = :layerKey AND globalId = :globalId")
  suspend fun get(collectionId: String, dataLayerId: String, layerKey: String, globalId: String): FeatureEntity?
  @Query("SELECT * FROM feature WHERE collectionId = :collectionId AND dataLayerId = :dataLayerId AND layerKey = :layerKey ORDER BY globalId LIMIT 1")
  suspend fun firstForLayer(collectionId: String, dataLayerId: String, layerKey: String): FeatureEntity?
  @Query("DELETE FROM feature WHERE collectionId = :collectionId AND dataLayerId = :dataLayerId AND layerKey = :layerKey")
  suspend fun deleteForLayer(collectionId: String, dataLayerId: String, layerKey: String)
  @Query("DELETE FROM feature WHERE collectionId = :collectionId") suspend fun deleteForCollection(collectionId: String)
}

@Dao
interface FormDao {
  @Upsert suspend fun upsert(row: FormEntity)
  @Query("SELECT * FROM form WHERE id = :id") suspend fun get(id: String): FormEntity?
}

@Dao
interface OfflinePackageDao {
  @Upsert suspend fun upsert(row: OfflinePackageEntity)
  @Query("SELECT * FROM offline_package WHERE collectionId = :collectionId") suspend fun forCollection(collectionId: String): List<OfflinePackageEntity>
  @Query("DELETE FROM offline_package WHERE collectionId = :collectionId AND areaId = :areaId") suspend fun delete(collectionId: String, areaId: String)
}

@Dao
interface QueueDao {
  @Upsert suspend fun upsert(row: QueueEntity)
  @Query("SELECT * FROM queue WHERE collectionId = :collectionId AND id = :id") suspend fun get(collectionId: String, id: String): QueueEntity?
  @Query("SELECT * FROM queue WHERE collectionId = :collectionId ORDER BY queuedAt") suspend fun forCollection(collectionId: String): List<QueueEntity>
  @Query("SELECT * FROM queue WHERE collectionId = :collectionId ORDER BY queuedAt") fun observeForCollection(collectionId: String): Flow<List<QueueEntity>>
  @Query("SELECT * FROM queue WHERE collectionId = :collectionId AND dataLayerId = :dataLayerId AND layerKey = :layerKey AND globalId = :globalId ORDER BY queuedAt")
  suspend fun forFeature(collectionId: String, dataLayerId: String, layerKey: String, globalId: String): List<QueueEntity>
  @Query("SELECT * FROM queue WHERE collectionId = :collectionId AND syncStatus = :status ORDER BY queuedAt")
  suspend fun byStatus(collectionId: String, status: String): List<QueueEntity>
  @Query("DELETE FROM queue WHERE collectionId = :collectionId AND id = :id") suspend fun delete(collectionId: String, id: String)

  /**
   * Claim a row for a drain: flip it to 'syncing' and stamp the
   * attempt, but only if it is still in the state the caller saw.
   * Returns the rows changed, so 0 means another drain took it. The
   * conditional UPDATE is what makes the claim atomic; the web store
   * does the same inside one IndexedDB transaction.
   */
  @Query(
    "UPDATE queue SET syncStatus = 'syncing', lastAttemptAt = :attemptAt " +
      "WHERE collectionId = :collectionId AND id = :id AND syncStatus = :expectedStatus " +
      // SQLite's IS treats two NULLs as equal, so one clause covers a
      // never-attempted row and an attempted one.
      "AND lastAttemptAt IS :expectedAttemptAt",
  )
  suspend fun claim(collectionId: String, id: String, expectedStatus: String, expectedAttemptAt: String?, attemptAt: String): Int

  @Transaction
  suspend fun replaceChain(collectionId: String, removeIds: List<String>, keep: QueueEntity?) {
    for (id in removeIds) delete(collectionId, id)
    if (keep != null) upsert(keep)
  }
}
