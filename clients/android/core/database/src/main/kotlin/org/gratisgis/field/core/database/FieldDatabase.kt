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
    DraftEntity::class,
  ],
  version = 3,
  exportSchema = true,
)
abstract class FieldDatabase : RoomDatabase() {
  abstract fun collections(): CollectionDao
  abstract fun layers(): LayerDao
  abstract fun features(): FeatureDao
  abstract fun forms(): FormDao
  abstract fun offlinePackages(): OfflinePackageDao
  abstract fun queue(): QueueDao
  abstract fun drafts(): DraftDao

  companion object {
    fun open(context: Context): FieldDatabase {
      // #region agent log
      DebugNdjson.init(context)
      val dbPath = context.applicationContext.getDatabasePath("gratisgis-field.db")
      DebugNdjson.log(
        "B",
        "FieldDatabase.kt:open",
        "opening Room DB",
        mapOf(
          "path" to dbPath.absolutePath,
          "exists" to dbPath.exists(),
          "length" to (if (dbPath.exists()) dbPath.length() else -1L),
          "version" to 3,
          "destructiveMigration" to false,
        ),
      )
      // #endregion
      return Room.databaseBuilder(context.applicationContext, FieldDatabase::class.java, "gratisgis-field.db")
        .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
        .build()
        .also { db ->
          // #region agent log
          DebugNdjson.log(
            "B",
            "FieldDatabase.kt:open",
            "Room DB built",
            mapOf(
              "openHelperDbName" to db.openHelper.databaseName,
              "isOpen" to db.isOpen,
            ),
          )
          // #endregion
        }
    }

    /** v2: queue rows carry the optimistic-concurrency base and, on a
     *  409, the server's current version. Additive; old rows read as
     *  null and replay exactly as they did. */
    val MIGRATION_1_2 = object : Migration(1, 2) {
      override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE queue ADD COLUMN baseObservationId TEXT")
        connection.execSQL("ALTER TABLE queue ADD COLUMN conflictCurrentJson TEXT")
      }
    }

    /** v3: form drafts for A1 offline save (not the sync queue). */
    val MIGRATION_2_3 = object : Migration(2, 3) {
      override fun migrate(connection: SQLiteConnection) {
        connection.execSQL(
          "CREATE TABLE IF NOT EXISTS `draft` (" +
            "`id` TEXT NOT NULL, " +
            "`collectionId` TEXT NOT NULL, " +
            "`formId` TEXT NOT NULL, " +
            "`layerKey` TEXT, " +
            "`dataLayerId` TEXT, " +
            "`responseJson` TEXT NOT NULL, " +
            "`updatedAt` TEXT NOT NULL, " +
            "PRIMARY KEY(`id`))",
        )
        connection.execSQL(
          "CREATE INDEX IF NOT EXISTS `index_draft_collectionId` ON `draft` (`collectionId`)",
        )
        connection.execSQL(
          "CREATE INDEX IF NOT EXISTS `index_draft_collectionId_formId` ON `draft` (`collectionId`, `formId`)",
        )
      }
    }
  }
}
