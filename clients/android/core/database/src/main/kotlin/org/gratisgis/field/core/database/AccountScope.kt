// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

/**
 * The account the device is working for right now: the signed-in
 * user's token `sub` and the portal they signed in to. Room keeps every
 * user's rows on a shared device, so every screen that lists or acts on
 * cached collections, drafts or queued edits goes through this.
 *
 * `portal` is the portal's API base URL as discovery returned it. A
 * user id is only unique within one portal's identity provider, so
 * both have to match.
 */
data class AccountScope(val userId: String, val portal: String) {

  /**
   * A cached collection is this account's only when this account
   * downloaded it on this portal. A row from before owners were
   * recorded belongs to nobody: it reads as not downloaded until the
   * next download claims it (and re-pulls its features).
   */
  fun ownsCollection(row: CollectionEntity): Boolean =
    row.ownerUserId == userId && row.portal == portal

  /**
   * Same rule as the queue's `isQueueRowOwnedBy` in shared-types: a
   * draft with no owner predates owners and belongs to whoever is
   * signed in, so work saved in good faith on an older build is not
   * stranded. Every draft saved from now on carries both.
   */
  fun ownsDraft(row: DraftEntity): Boolean =
    owns(row.ownerUserId, row.portal)

  /** See [ownsDraft]; the drain applies the same rule. */
  fun ownsQueueRow(row: QueueEntity): Boolean =
    owns(row.ownerUserId, row.portal)

  /** Whether a queue row recorded against `rowPortal` may be sent to
   *  this portal. A row with no portal predates the column. */
  fun samePortal(rowPortal: String?): Boolean = rowPortal == null || rowPortal == portal

  private fun owns(ownerUserId: String?, rowPortal: String?): Boolean =
    (ownerUserId == null || ownerUserId == userId) && samePortal(rowPortal)

  companion object {
    /** The key stored in the `portal` columns for an API base URL. */
    fun portalKey(apiBaseUrl: String): String = apiBaseUrl.trim().trimEnd('/')
  }
}
