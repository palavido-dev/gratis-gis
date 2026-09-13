// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
  entities = [
    CollectionEntity::class,
    LayerEntity::class,
    FeatureEntity::class,
    FormEntity::class,
    OfflinePackageEntity::class,
    QueueEntity::class,
  ],
  version = 1,
  exportSchema = true,
)
abstract class FieldDatabase : RoomDatabase() {
  abstract fun collections(): CollectionDao
  abstract fun layers(): LayerDao
  abstract fun features(): FeatureDao
  abstract fun forms(): FormDao
  abstract fun offlinePackages(): OfflinePackageDao
  abstract fun queue(): QueueDao

  companion object {
    fun open(context: Context): FieldDatabase =
      Room.databaseBuilder(context.applicationContext, FieldDatabase::class.java, "gratisgis-field.db")
        .build()
  }
}
