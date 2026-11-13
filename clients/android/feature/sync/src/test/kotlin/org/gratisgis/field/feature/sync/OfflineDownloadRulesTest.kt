// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.network.PortalError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
}
