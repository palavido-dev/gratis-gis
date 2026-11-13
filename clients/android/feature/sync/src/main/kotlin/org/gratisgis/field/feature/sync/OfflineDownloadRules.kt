// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.network.PortalError
import java.io.File
import java.time.Instant

/** An older server truncated a page that is all one version and
 *  gave no `nextAfter`; paging cannot progress, so pull in full. */
internal class DeltaStalled : IllegalStateException("Delta cannot page past one version on this server")

/** The small decisions inside OfflineDownloader, kept pure so they
 *  can be unit tested without a database or an engine. */
internal object OfflineDownloadRules {
  /** Ids per `deleteByGlobalIds` call. SQLite before Android 11 caps a
   *  statement at 999 bound values; the query binds three more. */
  const val DELETE_CHUNK = 900

  /**
   * Whether a failed delta refresh should fall back to a full pull.
   * Only when the cursor itself is the problem: a server that cannot
   * page past one version, or a 4xx (Gone, Not Found, bad cursor).
   * A timeout, a dropped connection, a 5xx, auth or rate limiting
   * stays a shortfall: pulling the whole layer over the same bad link
   * would only fail slower.
   */
  fun shouldFallbackToFull(t: Throwable): Boolean {
    if (t is DeltaStalled) return true
    val err = t as? PortalError ?: return false
    return err.status in 400..499 && err !is PortalError.Auth && err !is PortalError.RateLimit
  }

  /**
   * The `cachedAt` a full pull stamps on its rows. It must differ from
   * `runStamp`, which delta pages of the same run write, so the stale
   * sweep after the pull can tell the two apart.
   */
  fun fullPullStamp(now: Instant, runStamp: String): String {
    val text = now.toString()
    return if (text != runStamp) text else now.plusMillis(1).toString()
  }

  /** Whether the stored package for an area is already `packageId`
   *  with its file in place. */
  fun isPackageCurrent(stored: OfflinePackageEntity?, packageId: String): Boolean =
    stored != null && stored.packageId == packageId && File(stored.filePath).isFile
}
