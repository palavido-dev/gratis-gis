// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import org.gratisgis.field.core.database.CachedLayerRef
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.network.PortalError
import java.io.File
import java.time.Instant

/** `[west, south, east, north]` in degrees. */
internal typealias Box = List<Double>

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

  /**
   * A layer with more features than this is cached only inside the
   * collection's offline areas on a full pull. Under it the whole layer
   * is cached, so a collector can still open features outside the
   * areas. About 50 MB of feature JSON at a typical 1 KB a feature.
   */
  const val LIMIT_TO_AREAS_ABOVE = 50_000L

  /**
   * The smallest box holding every offline area's bbox in the
   * collection's `data.offlineAreas`, or null when it declares none.
   * One box, not one per area: a delta cursor is good for exactly one
   * box, and this is the same union the web download keeps.
   */
  fun offlineAreaEnvelope(collectionData: JsonObject?): Box? {
    val areas = collectionData?.get("offlineAreas") as? JsonArray ?: return null
    var out: Box? = null
    for (area in areas) {
      val box = parseBox((area as? JsonObject)?.get("bbox") as? JsonArray) ?: continue
      out = union(out, box)
    }
    return out
  }

  /** The box a full pull of a layer with `featureCount` features is
   *  limited to: the area envelope when the layer is over the limit,
   *  else null (the whole layer). An unknown count is not limited. */
  fun fullPullBox(featureCount: Long?, envelope: Box?): Box? =
    if (featureCount != null && featureCount > LIMIT_TO_AREAS_ABOVE) envelope else null

  /**
   * Whether the features cached for `have` (null: the whole layer)
   * hold everything inside `want` (null: the whole layer). A delta
   * only reports changes, so when they do not, the layer needs a full
   * pull. Mirrors `bboxCovers` in offline-download.ts.
   */
  fun covers(have: Box?, want: Box?): Boolean {
    if (have == null) return true
    if (want == null) return false
    return have[0] <= want[0] && have[1] <= want[1] && have[2] >= want[2] && have[3] >= want[3]
  }

  fun encodeBox(box: Box?): String? = box?.let { JsonArray(it.map { n -> JsonPrimitive(n) }).toString() }

  fun decodeBox(text: String?): Box? =
    text?.let { runCatching { parseBox(kotlinx.serialization.json.Json.parseToJsonElement(it) as? JsonArray) }.getOrNull() }

  /**
   * Layers that still have cached features but are no longer among the
   * collection's layers. Their features can no longer be opened from
   * the collection, so a successful refresh deletes them.
   */
  fun layersToPrune(cached: List<CachedLayerRef>, current: List<LayerEntity>): List<CachedLayerRef> {
    val keep = current.map { it.dataLayerId to it.layerKey }.toSet()
    return cached.filter { (it.dataLayerId to it.layerKey) !in keep }
  }

  private fun parseBox(arr: JsonArray?): Box? {
    if (arr == null || arr.size != 4) return null
    val nums = arr.map { (it as? JsonPrimitive)?.doubleOrNull ?: return null }
    if (nums.any { !it.isFinite() } || nums[0] > nums[2] || nums[1] > nums[3]) return null
    return nums
  }

  private fun union(a: Box?, b: Box): Box =
    if (a == null) b
    else listOf(minOf(a[0], b[0]), minOf(a[1], b[1]), maxOf(a[2], b[2]), maxOf(a[3], b[3]))
}
