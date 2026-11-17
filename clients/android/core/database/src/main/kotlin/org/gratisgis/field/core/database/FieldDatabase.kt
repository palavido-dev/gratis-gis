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
  version = 5,
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
    fun open(context: Context): FieldDatabase =
      Room.databaseBuilder(context.applicationContext, FieldDatabase::class.java, "gratisgis-field.db")
        .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5)
        // Survive abrupt process death after a draft upsert / package write.
        .setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)
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

    /** v4: per-layer syncVersion cursor for `delta?since=N` refresh
     *  (R4-android-field-delta / portal-web #350). Null on existing
     *  rows → next download still takes the full GeoJSON path once. */
    val MIGRATION_3_4 = object : Migration(3, 4) {
      override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE layer ADD COLUMN syncVersion INTEGER")
      }
    }

    /**
     * v5: who owns each cached collection, draft and queued edit, and on
     * which portal, so a shared device shows each account only its own
     * work. Old rows get nulls; see [AccountScope] for how those read.
     * Layers record the box their features were limited to (null is
     * the whole layer, which is what every existing cache holds).
     * Queued edits get the "may have reached the server" flag. A row a
     * drain already tried may have landed, so it starts out set.
     */
    val MIGRATION_4_5 = object : Migration(4, 5) {
      override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE collection ADD COLUMN ownerUserId TEXT")
        connection.execSQL("ALTER TABLE collection ADD COLUMN portal TEXT")
        connection.execSQL("ALTER TABLE layer ADD COLUMN syncBboxJson TEXT")
        connection.execSQL("ALTER TABLE queue ADD COLUMN portal TEXT")
        connection.execSQL("ALTER TABLE queue ADD COLUMN mayHaveReachedServer INTEGER NOT NULL DEFAULT 0")
        connection.execSQL("UPDATE queue SET mayHaveReachedServer = 1 WHERE lastAttemptAt IS NOT NULL")
        connection.execSQL("ALTER TABLE draft ADD COLUMN ownerUserId TEXT")
        connection.execSQL("ALTER TABLE draft ADD COLUMN portal TEXT")
      }
    }
  }
}
