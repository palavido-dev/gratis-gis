// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.execSQL

@Database(
  entities = [
    CollectionEntity::class,
    LayerEntity::class,
    FeatureEntity::class,
    FormEntity::class,
    OfflinePackageEntity::class,
    QueueEntity::class,
  ],
  version = 2,
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
        .addMigrations(MIGRATION_1_2)
        .build()

    /** v2: queue rows carry the optimistic-concurrency base and, on a
     *  409, the server's current version. Additive; old rows read as
     *  null and replay exactly as they did. */
    val MIGRATION_1_2 = object : Migration(1, 2) {
      override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE queue ADD COLUMN baseObservationId TEXT")
        connection.execSQL("ALTER TABLE queue ADD COLUMN conflictCurrentJson TEXT")
      }
    }
  }
}
