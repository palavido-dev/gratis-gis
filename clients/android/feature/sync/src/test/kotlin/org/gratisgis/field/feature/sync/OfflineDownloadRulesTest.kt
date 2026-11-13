// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.gratisgis.field.core.database.CachedLayerRef
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.network.PortalError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.time.Instant

class OfflineDownloadRulesTest {

  @Test
  fun fallsBackToAFullPullOnlyWhenTheCursorIsTheProblem() {
    assertTrue(OfflineDownloadRules.shouldFallbackToFull(DeltaStalled()))
    assertTrue(OfflineDownloadRules.shouldFallbackToFull(PortalError.NotFound("gone")))
    assertTrue(OfflineDownloadRules.shouldFallbackToFull(PortalError.Validation(400, "bad cursor")))
    assertTrue(OfflineDownloadRules.shouldFallbackToFull(PortalError.Server(410, "gone")))
  }

  @Test
  fun aTransientFailureStaysAShortfall() {
    assertFalse(OfflineDownloadRules.shouldFallbackToFull(IOException("timeout")))
    assertFalse(OfflineDownloadRules.shouldFallbackToFull(IllegalStateException("parse")))
    assertFalse(OfflineDownloadRules.shouldFallbackToFull(PortalError.Server(503, "down")))
    assertFalse(OfflineDownloadRules.shouldFallbackToFull(PortalError.Auth(401, "auth")))
    assertFalse(OfflineDownloadRules.shouldFallbackToFull(PortalError.RateLimit(429, "slow", null)))
  }

  @Test
  fun theFullPullStampNeverEqualsTheRunStamp() {
    val t = Instant.parse("2026-11-13T10:00:00.123Z")
    assertNotEquals(t.toString(), OfflineDownloadRules.fullPullStamp(t, t.toString()))
    assertEquals(t.toString(), OfflineDownloadRules.fullPullStamp(t, "2026-11-13T09:00:00Z"))
  }

  @Test
  fun aStoredPackageIsCurrentOnlyForTheSameIdWithItsFile() {
    val file = File.createTempFile("area", ".pmtiles")
    try {
      val stored = OfflinePackageEntity("c1", "a1", "p1", "Area", file.absolutePath, 10, "2026-11-01T00:00:00Z")
      assertTrue(OfflineDownloadRules.isPackageCurrent(stored, "p1"))
      assertFalse(OfflineDownloadRules.isPackageCurrent(stored, "p2"))
      assertFalse(OfflineDownloadRules.isPackageCurrent(null, "p1"))
      file.delete()
      assertFalse(OfflineDownloadRules.isPackageCurrent(stored, "p1"))
    } finally {
      file.delete()
    }
  }

  @Test
  fun deleteChunksStayUnderTheOldSqliteLimit() {
    // Three more values are bound besides the ids.
    assertTrue(OfflineDownloadRules.DELETE_CHUNK + 3 <= 999)
  }

  private fun areas(vararg boxes: List<Double>?) = buildJsonObject {
    put(
      "offlineAreas",
      buildJsonArray {
        for (b in boxes) {
          add(buildJsonObject { if (b != null) put("bbox", buildJsonArray { b.forEach { add(JsonPrimitive(it)) } }) })
        }
      },
    )
  }

  @Test
  fun theAreaEnvelopeHoldsEveryOfflineArea() {
    val env = OfflineDownloadRules.offlineAreaEnvelope(areas(listOf(-117.0, 33.0, -116.5, 33.5), listOf(-116.0, 34.0, -115.8, 34.2)))
    assertEquals(listOf(-117.0, 33.0, -115.8, 34.2), env)
  }

  @Test
  fun noUsableAreaMeansNoEnvelope() {
    assertNull(OfflineDownloadRules.offlineAreaEnvelope(null))
    assertNull(OfflineDownloadRules.offlineAreaEnvelope(buildJsonObject {}))
    // A missing or inverted bbox is skipped, not trusted.
    assertNull(OfflineDownloadRules.offlineAreaEnvelope(areas(null, listOf(1.0, 1.0, 0.0, 0.0))))
  }

  @Test
  fun onlyALayerOverTheLimitIsLimitedToTheAreas() {
    val env = listOf(0.0, 0.0, 1.0, 1.0)
    val over = OfflineDownloadRules.LIMIT_TO_AREAS_ABOVE + 1
    assertEquals(env, OfflineDownloadRules.fullPullBox(over, env))
    assertNull(OfflineDownloadRules.fullPullBox(OfflineDownloadRules.LIMIT_TO_AREAS_ABOVE, env))
    assertNull(OfflineDownloadRules.fullPullBox(null, env))
    assertNull(OfflineDownloadRules.fullPullBox(over, null))
  }

  @Test
  fun aDeltaIsUsedOnlyWhenTheCachedBoxCoversWhatIsWanted() {
    val big = listOf(0.0, 0.0, 10.0, 10.0)
    val small = listOf(1.0, 1.0, 2.0, 2.0)
    assertTrue(OfflineDownloadRules.covers(null, big))
    assertTrue(OfflineDownloadRules.covers(null, null))
    assertTrue(OfflineDownloadRules.covers(big, small))
    assertFalse(OfflineDownloadRules.covers(small, big))
    // Limited before, whole layer wanted now: needs a full pull.
    assertFalse(OfflineDownloadRules.covers(small, null))
  }

  @Test
  fun aBoxSurvivesTheLayerRow() {
    val box = listOf(-117.25, 33.5, -116.0, 34.0)
    assertEquals(box, OfflineDownloadRules.decodeBox(OfflineDownloadRules.encodeBox(box)))
    assertNull(OfflineDownloadRules.encodeBox(null))
    assertNull(OfflineDownloadRules.decodeBox(null))
    assertNull(OfflineDownloadRules.decodeBox("not json"))
  }

  @Test
  fun featuresOfLayersNoLongerInTheCollectionArePruned() {
    fun layer(id: String, key: String) =
      LayerEntity("c1", id, key, key, "Point", "[]", "h", "all-rows", true, null)
    val cached = listOf(CachedLayerRef("dl1", "main"), CachedLayerRef("dl1", "old"), CachedLayerRef("dl2", "main"))
    val gone = OfflineDownloadRules.layersToPrune(cached, listOf(layer("dl1", "main"), layer("dl2", "main")))
    assertEquals(listOf(CachedLayerRef("dl1", "old")), gone)
  }
}

