// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.gratisgis.field.core.network.LayerDeltaChange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LayerDeltaApplyTest {

  private val json = Json { ignoreUnknownKeys = true }

  private fun change(
    entity: String,
    kind: String,
    properties: JsonObject? = buildJsonObject { put("name", entity) },
    geometry: kotlinx.serialization.json.JsonElement? = buildJsonObject {
      put("type", "Point")
      put("coordinates", kotlinx.serialization.json.buildJsonArray {
        add(kotlinx.serialization.json.JsonPrimitive(1.0))
        add(kotlinx.serialization.json.JsonPrimitive(2.0))
      })
    },
    syncVersion: Long = 1,
  ) = LayerDeltaChange(
    observationId = "obs-$entity-$kind",
    entity = entity,
    kind = kind,
    syncVersion = syncVersion,
    geometry = geometry,
    properties = properties,
  )

  @Test
  fun upsertsCreateUpdateDeriveObserveByEntityId() {
    val result = LayerDeltaApply.applyDeltaChanges(
      listOf(
        change("a", "create"),
        change(
          "b",
          "update",
          properties = buildJsonObject { put("name", "bee") },
          geometry = buildJsonObject {
            put("type", "Point")
            put(
              "coordinates",
              kotlinx.serialization.json.buildJsonArray {
                add(kotlinx.serialization.json.JsonPrimitive(3.0))
                add(kotlinx.serialization.json.JsonPrimitive(4.0))
              },
            )
          },
        ),
        change("c", "derive", properties = buildJsonObject { put("d", 1) }),
        change("d", "observe", properties = buildJsonObject { put("o", true) }),
      ),
      collectionId = "dc-1",
      dataLayerId = "dl-1",
      layerKey = "main",
      cachedAt = "2026-10-27T00:00:00.000Z",
    )
    assertTrue(result.deletes.isEmpty())
    assertEquals(listOf("a", "b", "c", "d"), result.upserts.map { it.globalId }.sorted())
    val b = result.upserts.first { it.globalId == "b" }
    val feature = json.parseToJsonElement(b.featureJson).jsonObject
    assertEquals("b", feature["id"]?.jsonPrimitive?.contentOrNull)
    val props = feature["properties"]!!.jsonObject
    assertEquals("bee", props["name"]?.jsonPrimitive?.contentOrNull)
    assertEquals("b", props["_global_id"]?.jsonPrimitive?.contentOrNull)
  }

  @Test
  fun collectsDeleteTombstonesAndLetsLaterDeleteWin() {
    val result = LayerDeltaApply.applyDeltaChanges(
      listOf(
        change("gone", "create"),
        change("gone", "delete", geometry = JsonNull, properties = null),
        change("keep", "create"),
      ),
      collectionId = "dc-1",
      dataLayerId = "dl-1",
      layerKey = "main",
      cachedAt = "2026-10-27T00:00:00.000Z",
    )
    assertEquals(listOf("gone"), result.deletes)
    assertEquals(listOf("keep"), result.upserts.map { it.globalId })
  }

  @Test
  fun laterUpsertRevivesEntityDeletedEarlierInPage() {
    val result = LayerDeltaApply.applyDeltaChanges(
      listOf(
        change("x", "delete", geometry = JsonNull, properties = null),
        change("x", "create", properties = buildJsonObject { put("back", true) }),
      ),
      collectionId = "dc-1",
      dataLayerId = "dl-1",
      layerKey = "main",
      cachedAt = "2026-10-27T00:00:00.000Z",
    )
    assertTrue(result.deletes.isEmpty())
    assertEquals(1, result.upserts.size)
    val props = json.parseToJsonElement(result.upserts[0].featureJson)
      .jsonObject["properties"]!!.jsonObject
    assertEquals(true, props["back"]?.jsonPrimitive?.booleanOrNull)
    assertEquals("x", props["_global_id"]?.jsonPrimitive?.contentOrNull)
  }
}
