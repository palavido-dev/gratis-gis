// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.gratisgis.field.core.database.QueueEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConflictReapplyTest {

  private val json = Json { ignoreUnknownKeys = true }

  private fun row(
    op: String,
    globalId: String = "f1",
    propertiesJson: String? = buildJsonObject {
      put("name", "Oak")
      put("_global_id", "f1")
      put("_observation_id", "old-obs")
    }.toString(),
    geometryJson: String? = buildJsonObject {
      put("type", "Point")
      put(
        "coordinates",
        buildJsonArray {
          add(kotlinx.serialization.json.JsonPrimitive(1.0))
          add(kotlinx.serialization.json.JsonPrimitive(2.0))
        },
      )
    }.toString(),
  ) = QueueEntity(
    id = "q1",
    collectionId = "dc-1",
    op = op,
    dataLayerId = "dl-1",
    layerKey = "main",
    globalId = globalId,
    geometryJson = geometryJson,
    propertiesJson = propertiesJson,
    queuedAt = "2026-10-27T12:00:00.000Z",
    schemaHash = "hash",
    syncStatus = "rejected",
    failureJson = """{"code":"sync.conflict"}""",
    lastAttemptAt = "2026-10-27T12:01:00.000Z",
    retryCount = 1,
    ownerUserId = "u1",
    baseObservationId = "old-obs",
    conflictCurrentJson = null,
  )

  @Test
  fun stripUserPropertiesDropsUnderscoreKeys() {
    val props = buildJsonObject {
      put("name", "Oak")
      put("_global_id", "g")
      put("_observation_id", "o")
      put("count", 3)
    }
    val stripped = ConflictReapply.stripUserProperties(props)
    assertEquals("Oak", stripped["name"]!!.jsonPrimitive.content)
    assertEquals(3, stripped["count"]!!.jsonPrimitive.content.toInt())
    assertTrue(stripped.keys.none { it.startsWith("_") })
  }

  @Test
  fun liveHeadFromNullMeansDeleted() {
    assertEquals(ConflictLiveHead(exists = false), ConflictReapply.liveHeadFromCurrentJson(null))
    assertEquals(ConflictLiveHead(exists = false), ConflictReapply.liveHeadFromCurrentJson("null"))
    assertEquals(ConflictLiveHead(exists = false), ConflictReapply.liveHeadFromCurrentJson(JsonNull.toString()))
  }

  @Test
  fun liveHeadReadsObservationId() {
    val current = buildJsonObject {
      put("type", "Feature")
      put("id", "f1")
      put("properties", buildJsonObject {
        put("name", "Live")
        put("_observation_id", "live-obs")
      })
    }.toString()
    assertEquals(
      ConflictLiveHead(exists = true, observationId = "live-obs"),
      ConflictReapply.liveHeadFromCurrentJson(current),
    )
  }

  @Test
  fun patchesUpdateWhenFeatureStillLive() {
    val plan = ConflictReapply.plan(
      row("update"),
      ConflictLiveHead(exists = true, observationId = "live-obs"),
    )
    val patch = plan as ConflictReapplyPlan.Patch
    assertEquals("f1", patch.featureId)
    assertEquals("live-obs", patch.baseObservationId)
    assertEquals("Oak", patch.properties["name"]!!.jsonPrimitive.content)
    assertTrue(patch.properties.keys.none { it.startsWith("_") })
    assertEquals("Point", patch.geometry!!.jsonObject["type"]!!.jsonPrimitive.content)
  }

  @Test
  fun postsRecreateWhenUpdateTargetGone() {
    val plan = ConflictReapply.plan(
      row("update"),
      ConflictLiveHead(exists = false),
    )
    val post = plan as ConflictReapplyPlan.Post
    assertEquals("f1", post.globalId)
    assertEquals("Oak", post.properties["name"]!!.jsonPrimitive.content)
  }

  @Test
  fun deletesWhenLostDeleteStillLive() {
    val plan = ConflictReapply.plan(
      row("delete", propertiesJson = null, geometryJson = null),
      ConflictLiveHead(exists = true, observationId = "live-obs"),
    )
    assertEquals(
      ConflictReapplyPlan.Delete(featureId = "f1", baseObservationId = "live-obs"),
      plan,
    )
  }

  @Test
  fun noopsWhenLostDeleteAlreadyGone() {
    val plan = ConflictReapply.plan(
      row("delete", propertiesJson = null, geometryJson = null),
      ConflictLiveHead(exists = false),
    )
    assertEquals(ConflictReapplyPlan.Noop(reason = "already-deleted"), plan)
  }

  @Test
  fun refusesUpdateWithoutLosingProperties() {
    val plan = ConflictReapply.plan(
      row("update", propertiesJson = null),
      ConflictLiveHead(exists = true, observationId = "o"),
    )
    assertEquals(
      ConflictReapplyPlan.Unavailable(reason = "missing-losing-side"),
      plan,
    )
  }
}
