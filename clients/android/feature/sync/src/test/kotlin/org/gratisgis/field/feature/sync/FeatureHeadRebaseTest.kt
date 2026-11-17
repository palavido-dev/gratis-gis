// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.gratisgis.field.core.database.QueueEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureHeadRebaseTest {

  private fun row(
    id: String,
    queuedAt: String,
    status: String = "pending",
    owner: String? = "u1",
    base: String? = "obs-1",
    globalId: String = "g1",
  ) = QueueEntity(
    id = id,
    collectionId = "c1",
    op = "update",
    dataLayerId = "dl1",
    layerKey = "main",
    globalId = globalId,
    geometryJson = null,
    propertiesJson = """{"name":"x"}""",
    queuedAt = queuedAt,
    schemaHash = "h",
    syncStatus = status,
    failureJson = null,
    lastAttemptAt = null,
    retryCount = null,
    ownerUserId = owner,
    baseObservationId = base,
  )

  private val landed = row("a", "2026-11-01T00:00:00Z", status = "syncing")

  @Test
  fun movesLaterRowsOfTheSameFeatureAndOwner() {
    val later = row("b", "2026-11-01T00:01:00Z")
    val laterFailed = row("c", "2026-11-01T00:02:00Z", status = "failed")
    val out = FeatureHeadRebase.rowsToRebase(landed, listOf(landed, later, laterFailed), "obs-2")
    assertEquals(listOf("b", "c"), out.map { it.id })
    assertTrue(out.all { it.baseObservationId == "obs-2" })
  }

  @Test
  fun leavesEarlierOtherOwnerOtherFeatureParkedAndBaselessRowsAlone() {
    val rows = listOf(
      row("earlier", "2026-10-31T00:00:00Z"),
      row("otherOwner", "2026-11-01T00:01:00Z", owner = "u2"),
      row("legacy", "2026-11-01T00:01:00Z", owner = null),
      row("otherFeature", "2026-11-01T00:01:00Z", globalId = "g2"),
      row("parked", "2026-11-01T00:01:00Z", status = "rejected"),
      row("inFlight", "2026-11-01T00:01:00Z", status = "syncing"),
      row("noBase", "2026-11-01T00:01:00Z", base = null),
    )
    assertTrue(FeatureHeadRebase.rowsToRebase(landed, rows, "obs-2").isEmpty())
  }

  @Test
  fun leavesTheSameAccountsRowOnAnotherPortalAlone() {
    val here = landed.copy(portal = "https://one.example/api")
    val elsewhere = row("b", "2026-11-01T00:01:00Z").copy(portal = "https://two.example/api")
    assertTrue(FeatureHeadRebase.rowsToRebase(here, listOf(elsewhere), "obs-2").isEmpty())
  }

  @Test
  fun aLandedRowWithNoOwnerMovesNothing() {
    val legacy = landed.copy(ownerUserId = null)
    val later = row("b", "2026-11-01T00:01:00Z", owner = null)
    assertTrue(FeatureHeadRebase.rowsToRebase(legacy, listOf(later), "obs-2").isEmpty())
  }

  @Test
  fun rewritesTheCachedTokenOnlyWhenItIsStillTheLandedBase() {
    val feature = """{"type":"Feature","id":"g1","properties":{"name":"x","_observation_id":"obs-1"}}"""
    val next = FeatureHeadRebase.rebasedFeatureJson(feature, "obs-1", "obs-2")!!
    val props = Json.parseToJsonElement(next).jsonObject.getValue("properties").jsonObject
    assertEquals("obs-2", props.getValue("_observation_id").jsonPrimitive.content)
    assertEquals("x", props.getValue("name").jsonPrimitive.content)

    // A newer token that already arrived by delta is not moved back.
    val newer = """{"type":"Feature","properties":{"_observation_id":"obs-9"}}"""
    assertNull(FeatureHeadRebase.rebasedFeatureJson(newer, "obs-1", "obs-2"))
  }

  @Test
  fun setsTheTokenWhenTheCacheHasNone() {
    val feature = """{"type":"Feature","properties":{"name":"x"}}"""
    val next = FeatureHeadRebase.rebasedFeatureJson(feature, "obs-1", "obs-2")!!
    assertEquals(
      "obs-2",
      Json.parseToJsonElement(next).jsonObject.getValue("properties").jsonObject.getValue("_observation_id").jsonPrimitive.content,
    )
  }

  @Test
  fun readsTheHeadFromAPatchResponse() {
    val body = buildJsonObject { put("properties", buildJsonObject { put("_observation_id", "obs-2") }) }
    assertEquals("obs-2", FeatureHeadRebase.headFromResponse(body))
    assertNull(FeatureHeadRebase.headFromResponse(null))
    assertNull(FeatureHeadRebase.headFromResponse(buildJsonObject { put("properties", buildJsonObject { put("_observation_id", "") }) }))
  }
}
