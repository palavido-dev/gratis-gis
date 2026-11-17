// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountScopeTest {

  private val a = AccountScope("user-a", "https://one.example/api")

  private fun collection(owner: String?, portal: String?) =
    CollectionEntity("c1", "Parcels", "m1", "{}", "2026-11-01T00:00:00Z", ownerUserId = owner, portal = portal)

  private fun draft(owner: String?, portal: String?) =
    DraftEntity("d1", "c1", "f1", "main", "dl1", "{}", "2026-11-01T00:00:00Z", ownerUserId = owner, portal = portal)

  private fun queued(owner: String?, portal: String?) = QueueEntity(
    id = "q1",
    collectionId = "c1",
    op = "update",
    dataLayerId = "dl1",
    layerKey = "main",
    globalId = "g1",
    geometryJson = null,
    propertiesJson = "{}",
    queuedAt = "2026-11-01T00:00:00Z",
    schemaHash = "h",
    syncStatus = "rejected",
    failureJson = null,
    lastAttemptAt = null,
    retryCount = null,
    ownerUserId = owner,
    portal = portal,
  )

  @Test
  fun aCachedCollectionIsShownOnlyToItsOwnerOnItsPortal() {
    assertTrue(a.ownsCollection(collection("user-a", "https://one.example/api")))
    assertFalse(a.ownsCollection(collection("user-b", "https://one.example/api")))
    assertFalse(a.ownsCollection(collection("user-a", "https://two.example/api")))
    // From before owners were recorded: nobody's until re-downloaded.
    assertFalse(a.ownsCollection(collection(null, null)))
  }

  @Test
  fun anotherAccountsQueuedEditIsNotOwned() {
    assertTrue(a.ownsQueueRow(queued("user-a", "https://one.example/api")))
    assertFalse(a.ownsQueueRow(queued("user-b", "https://one.example/api")))
    assertFalse(a.ownsQueueRow(queued("user-a", "https://two.example/api")))
  }

  @Test
  fun rowsFromBeforeTheColumnsFollowTheQueueOwnershipRule() {
    // Same rule as isQueueRowOwnedBy: an unowned row belongs to whoever
    // is signed in, so older captures are not stranded.
    assertTrue(a.ownsQueueRow(queued(null, null)))
    assertTrue(a.ownsQueueRow(queued("user-a", null)))
    assertTrue(a.ownsDraft(draft(null, null)))
  }

  @Test
  fun draftsAreScopedLikeQueuedEdits() {
    assertTrue(a.ownsDraft(draft("user-a", "https://one.example/api")))
    assertFalse(a.ownsDraft(draft("user-b", "https://one.example/api")))
    assertFalse(a.ownsDraft(draft("user-a", "https://two.example/api")))
  }

  @Test
  fun thePortalKeyIgnoresATrailingSlash() {
    assertEquals("https://one.example/api", AccountScope.portalKey("https://one.example/api/"))
    assertTrue(a.samePortal(null))
    assertFalse(a.samePortal("https://two.example/api"))
  }

  @Test
  fun newQueueRowsStartNotSent() {
    assertFalse(queued("user-a", null).mayHaveReachedServer)
  }
}
