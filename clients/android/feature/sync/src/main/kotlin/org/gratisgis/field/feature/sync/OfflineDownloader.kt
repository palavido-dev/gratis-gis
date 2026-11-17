// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.gratisgis.field.core.database.AccountScope
import org.gratisgis.field.core.database.CollectionEntity
import org.gratisgis.field.core.database.FeatureEntity
import org.gratisgis.field.core.database.FieldDatabase
import org.gratisgis.field.core.database.FormEntity
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.deleteByGlobalIds
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.network.ItemSummary
import org.gratisgis.field.core.network.OfflineAreaWithPackage
import org.gratisgis.field.core.network.PortalClient
import org.gratisgis.field.core.network.PortalError
import java.io.File
import java.time.Instant

/** Live status for the UI, as the download runs. */
data class DownloadProgress(
  val phase: String,
  val detail: String = "",
  val layers: Int = 0,
  val features: Int = 0,
  val forms: Int = 0,
  val packageBytes: Long = 0,
  val packageTotal: Long? = null,
  val shortfalls: List<String> = emptyList(),
  /** Labels of the layers whose features were limited to the offline
   *  areas because the layer is large. */
  val limitedLayers: List<String> = emptyList(),
)

/**
 * Take a data_collection offline: resolve its map's editable layers,
 * cache their features and schemas, fetch bound forms, and download
 * every ready basemap package. Mirrors `downloadDeployment` in
 * apps/portal-web/src/lib/offline-download.ts, minus pick lists and
 * attachments for now. A layer is cached whole, except that a layer
 * with more than [OfflineDownloadRules.LIMIT_TO_AREAS_ABOVE] features
 * is pulled only inside the box around the collection's offline areas
 * (the summary lists those layers).
 *
 * The cached copy belongs to the account that downloaded it
 * ([AccountScope]). Downloading a copy another account (or no
 * recorded account) left on the device first drops its features and
 * cursors, so nothing that account could read is carried over.
 *
 * Feature refresh uses `GET .../delta?since=N` when a per-layer
 * `syncVersion` cursor is already stored (portal-web #350 /
 * R4-android-field-delta), paging with `nextSince` / `nextAfter`.
 * First package (or unknown / broken cursor) reads the head cursor
 * first, then pulls the full GeoJSON with keyset paging.
 * docs/sync-protocol.md.
 *
 * Layer resolution follows apps/portal-web/src/app/items/[id]/field/page.tsx:
 * a map layer with `source.kind === 'data-layer'` names a data_layer
 * item and optionally a v3 sublayer key; the sublayer's `fields`,
 * `geometryType`, `editingPolicy` and `editingEnabled` come from the
 * data_layer item; the form binding comes from the collection.
 */
class OfflineDownloader(
  private val portal: PortalClient,
  private val db: FieldDatabase,
  private val engine: FieldEngine,
  private val packageDir: File,
) {
  private val json = Json { ignoreUnknownKeys = true }

  private companion object {
    /** Page size for the keyset-paged full GeoJSON pull. */
    const val FULL_PAGE_LIMIT = 5_000
  }

  /** Every broad catch below calls this first, so a cancelled
   *  download stops instead of logging each remaining step as a
   *  shortfall. */
  private suspend fun rethrowIfCancelled() = currentCoroutineContext().ensureActive()

  suspend fun download(collection: ItemSummary, scope: AccountScope, onProgress: (DownloadProgress) -> Unit) {
    var progress = DownloadProgress(phase = "resolving")
    fun report(p: DownloadProgress) { progress = p; onProgress(p) }
    val shortfalls = mutableListOf<String>()
    val data = collection.data ?: error("Collection ${collection.id} has no data")
    val mapId = data["mapId"]?.jsonPrimitive?.contentOrNull ?: error("Collection has no mapId")

    val stored = db.collections().get(collection.id)
    if (stored != null && !scope.ownsCollection(stored)) {
      // Another account's copy (or one from before owners were
      // recorded). Its rows were read with that account's access, so
      // start from nothing: no features, no cursors to delta from.
      db.features().deleteForCollection(collection.id)
      db.layers().deleteForCollection(collection.id)
    }
    val own = stored != null && scope.ownsCollection(stored)

    // Keep prior syncVersion cursors (and the box each is good for)
    // across the layer wipe+reupsert so a refresh can delta instead of
    // re-pulling every feature.
    val priorLayers = if (own) db.layers().forCollection(collection.id) else emptyList()
    val priorByKey = priorLayers.associateBy { "${it.dataLayerId}:${it.layerKey}" }
    // A refresh keeps the previous stamp until this run finishes: the
    // data from the last run is still on the device, and a refresh
    // that fails part way must not make it read as never downloaded.
    val priorDownloadedAt = if (own) stored?.downloadedAt else null
    val envelope = OfflineDownloadRules.offlineAreaEnvelope(data)
    val featureCounts = HashMap<String, Long>()

    // Editable layers.
    val map = portal.getItem(mapId)
    val layers = resolveLayers(collection, map, priorLayers, shortfalls, featureCounts).map { layer ->
      val prior = priorByKey["${layer.dataLayerId}:${layer.layerKey}"]
      if (prior?.syncVersion != null) layer.copy(syncVersion = prior.syncVersion, syncBboxJson = prior.syncBboxJson) else layer
    }
    if (shortfalls.isNotEmpty()) report(progress.copy(shortfalls = shortfalls.toList()))
    db.collections().upsert(
      CollectionEntity(
        id = collection.id,
        title = collection.title,
        mapId = mapId,
        dataJson = data.toString(),
        downloadedAt = priorDownloadedAt,
        ownerUserId = scope.userId,
        portal = scope.portal,
      ),
    )
    db.layers().deleteForCollection(collection.id)
    db.layers().upsertAll(layers)
    report(progress.copy(phase = "features", layers = layers.size))

    val now = Instant.now().toString()
    var featureCount = 0
    var layersPulled = 0
    val layersAfter = layers.toMutableList()
    val limited = mutableListOf<String>()
    for ((index, layer) in layers.withIndex()) {
      report(progress.copy(detail = layer.label))
      try {
        val cursor = layer.syncVersion
        // What a full pull of this layer would fetch now, and what the
        // cache holds. A delta keeps the box the cache was pulled for;
        // when that box misses part of what is wanted now (the areas
        // moved, or the layer is no longer limited), pull in full.
        val have = OfflineDownloadRules.decodeBox(layer.syncBboxJson)
        val count = featureCounts["${layer.dataLayerId}:${layer.layerKey}"]
        // No count this run (its item could not be read) keeps the box
        // the cache already has, rather than pulling a large layer whole.
        val want = if (count == null && have != null) have else OfflineDownloadRules.fullPullBox(count, envelope)
        val updated = if (cursor != null && OfflineDownloadRules.covers(have, want)) {
          try {
            pullLayerDelta(collection.id, layer, cursor, now, have)
          } catch (t: Throwable) {
            // Corrupt / unknown cursor or an older server: fall back
            // to a full GeoJSON once and re-seed (research
            // R4-android-field-delta). A transient failure is not one
            // of those and stays a shortfall.
            rethrowIfCancelled()
            if (OfflineDownloadRules.shouldFallbackToFull(t)) {
              pullFullAndSeed(collection.id, layer, now, want)
            } else {
              throw t
            }
          }
        } else {
          pullFullAndSeed(collection.id, layer, now, want)
        }
        layersAfter[index] = updated.layer
        if (updated.layer.syncBboxJson != null) {
          limited += layer.label
          report(progress.copy(limitedLayers = limited.toList()))
        }
        db.layers().upsertAll(listOf(updated.layer))
        featureCount += updated.applied
        layersPulled += 1
        report(progress.copy(features = featureCount))
      } catch (t: Throwable) {
        rethrowIfCancelled()
        shortfalls += "${layer.label}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    // Bound forms.
    report(progress.copy(phase = "forms"))
    var formCount = 0
    for (formId in layersAfter.mapNotNull { it.boundFormItemId }.distinct()) {
      try {
        val form = portal.getItem(formId)
        val schema = form.data ?: error("form has no schema")
        db.forms().upsert(
          FormEntity(
            id = formId,
            schemaJson = schema.toString(),
            requiredEngineVersion = schema["requiredEngineVersion"]?.jsonPrimitive?.intOrNull,
            cachedAt = now,
          ),
        )
        formCount += 1
        report(progress.copy(forms = formCount))
      } catch (t: Throwable) {
        rethrowIfCancelled()
        shortfalls += "form ${formId.take(8)}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    // Prepared basemap packages: every ready area.
    report(progress.copy(phase = "packages"))
    val areas: List<OfflineAreaWithPackage> = try {
      portal.listOfflineAreas(collection.id).areas
    } catch (t: Throwable) {
      // Same as any other step: a shortfall, not the end of the run.
      // The packages already on the device stay as they are.
      rethrowIfCancelled()
      shortfalls += "basemap areas: ${t.message}"
      report(progress.copy(shortfalls = shortfalls.toList()))
      emptyList()
    }
    val storedPackages = db.offlinePackages().forCollection(collection.id).associateBy { it.areaId }
    for (entry in areas) {
      val current = entry.current ?: continue
      if (current.status != "ready") continue
      // A package id names one build of the area. The same id with
      // its file still in place is the file we already have, so a
      // feature refresh does not pull hundreds of MB again.
      if (OfflineDownloadRules.isPackageCurrent(storedPackages[entry.area.id], current.id)) continue
      report(progress.copy(detail = entry.area.name, packageBytes = 0, packageTotal = current.sizeBytes))
      try {
        val file = downloadPackage(collection.id, entry.area.id, current.id) { received, total ->
          report(progress.copy(packageBytes = received, packageTotal = total ?: current.sizeBytes))
        }
        db.offlinePackages().upsert(
          OfflinePackageEntity(
            collectionId = collection.id,
            areaId = entry.area.id,
            packageId = current.id,
            areaName = entry.area.name,
            filePath = file.absolutePath,
            sizeBytes = file.length(),
            downloadedAt = now,
          ),
        )
      } catch (t: Throwable) {
        rethrowIfCancelled()
        shortfalls += "package ${entry.area.name}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    // A run in which no layer's features could be fetched has not
    // downloaded anything new, so it keeps the previous stamp (null
    // on a first download) rather than claiming it did.
    val fetchedAny = layers.isEmpty() || layersPulled > 0
    val downloadedAt = if (fetchedAny) now else priorDownloadedAt
    db.collections().upsert(
      CollectionEntity(
        collection.id,
        collection.title,
        mapId,
        data.toString(),
        downloadedAt = downloadedAt,
        ownerUserId = scope.userId,
        portal = scope.portal,
      ),
    )
    // Features of layers the map no longer has cannot be opened from
    // this collection, so a run that fetched something drops them.
    // Layers whose item could not be reached this time are still in
    // `layers` and keep their rows. Basemap packages of removed areas
    // stay until the collection itself is removed from the device.
    if (fetchedAny) {
      for (gone in OfflineDownloadRules.layersToPrune(db.features().cachedLayers(collection.id), layers)) {
        db.features().deleteForLayer(collection.id, gone.dataLayerId, gone.layerKey)
      }
    }
    report(progress.copy(phase = "done", detail = ""))
  }

  private data class LayerPull(val layer: LayerEntity, val applied: Int)

  /**
   * Walk `GET .../delta` pages until `truncated` clears, applying each
   * page (upsert + delete). Each truncated page names its last row in
   * `nextSince` / `nextAfter`; the engine's `sync.deltaNext` decides
   * the next request, so a write batch larger than a page arrives
   * whole. Stopping early stores the last version applied completely,
   * never a cursor past rows not yet applied. Mirrors portal-web
   * `pullLayerDelta`.
   */
  private suspend fun pullLayerDelta(
    collectionId: String,
    layer: LayerEntity,
    sinceStart: Long,
    cachedAt: String,
    bbox: Box?,
  ): LayerPull {
    var since = sinceStart
    var after: String? = null
    var applied = 0
    var safe = sinceStart
    for (page in 0 until 100) {
      val body = portal.getLayerDelta(
        layer.dataLayerId,
        layer.layerKey,
        since,
        LayerDeltaApply.DELTA_PAGE_LIMIT,
        after,
        bbox,
      )
      val (upserts, deletes) = LayerDeltaApply.applyDeltaChanges(
        body.changes,
        collectionId,
        layer.dataLayerId,
        layer.layerKey,
        cachedAt,
      )
      if (upserts.isNotEmpty()) db.features().insertAll(upserts)
      // Chunked: SQLite before Android 11 allows 999 bound values per
      // statement, and a page can carry thousands of tombstones.
      for (chunk in deletes.chunked(OfflineDownloadRules.DELETE_CHUNK)) {
        db.features().deleteByGlobalIds(
          collectionId,
          layer.dataLayerId,
          layer.layerKey,
          chunk,
        )
      }
      applied += upserts.size + deletes.size

      // The step reads only the page flags and its last row.
      val last = body.changes.lastOrNull()
      val step = engine.callOrThrow(
        "sync.deltaNext",
        buildJsonObject {
          put(
            "page",
            buildJsonObject {
              put("syncVersion", JsonPrimitive(body.syncVersion))
              put("truncated", JsonPrimitive(body.truncated))
              body.nextSince?.let { put("nextSince", JsonPrimitive(it)) }
              body.nextAfter?.let { put("nextAfter", JsonPrimitive(it)) }
              put(
                "changes",
                buildJsonArray {
                  if (last != null) {
                    add(
                      buildJsonObject {
                        put("observationId", JsonPrimitive(last.observationId))
                        put("entity", JsonPrimitive(last.entity))
                        put("kind", JsonPrimitive(last.kind))
                        put("syncVersion", JsonPrimitive(last.syncVersion))
                      },
                    )
                  }
                },
              )
            },
          )
          put("since", JsonPrimitive(since))
        },
      ).jsonObject
      when (step["kind"]?.jsonPrimitive?.contentOrNull) {
        "done" -> return LayerPull(layer.copy(syncVersion = step.getValue("cursor").jsonPrimitive.long), applied)
        "stalled" -> throw DeltaStalled()
        else -> {
          safe = step.getValue("safeCursor").jsonPrimitive.long
          since = step.getValue("since").jsonPrimitive.long
          after = step["after"]?.jsonPrimitive?.contentOrNull
        }
      }
    }
    return LayerPull(layer.copy(syncVersion = safe), applied)
  }

  /**
   * Full replace + seed. The head cursor is read FIRST: a write that
   * commits during the download is then newer than the stored cursor
   * and the next delta delivers it again (applying is idempotent).
   * Read after the pull, that write would be skipped for good. The
   * GeoJSON is walked with keyset paging (`limit`, then `cursor` and
   * `at` pinned to the first page's `asOf`), which works whether or
   * not the server allows unpaged reads.
   *
   * Each page is written as it arrives, under a stamp of its own, so a
   * large layer is never held in memory whole. Rows from before this
   * pull are removed only once every page has arrived (the ones that
   * no longer exist on the server keep the older stamp). If the pull
   * stops part way the layer still holds every row it had, some of
   * them newer, and the stored cursor is still the old one, so the
   * next delta brings the rest. The layer is never left empty.
   *
   * With a `bbox` only features inside it are pulled, and the sweep
   * then also removes the rows outside it; the box is stored with the
   * cursor so later deltas ask for the same box.
   */
  private suspend fun pullFullAndSeed(
    collectionId: String,
    layer: LayerEntity,
    now: String,
    bbox: Box?,
  ): LayerPull {
    val seeded = seedSyncVersionCursor(layer.dataLayerId, layer.layerKey)
    val stamp = OfflineDownloadRules.fullPullStamp(Instant.now(), now)
    var written = 0
    var cursor: String? = null
    var at: String? = null
    val seen = HashSet<String>()
    while (true) {
      val text = portal.getLayerGeoJson(
        layer.dataLayerId,
        layer.layerKey,
        bbox = bbox,
        limit = FULL_PAGE_LIMIT,
        cursor = cursor,
        at = at,
      )
      val body = json.parseToJsonElement(text).jsonObject
      val features = body["features"]?.jsonArray ?: JsonArray(emptyList())
      val rows = features.map { f ->
        val obj = f.jsonObject
        val props = obj["properties"] as? JsonObject
        val globalId = props?.get("_global_id")?.jsonPrimitive?.contentOrNull
          ?: obj["id"]?.jsonPrimitive?.contentOrNull
          ?: stableId(obj)
        FeatureEntity(collectionId, layer.dataLayerId, layer.layerKey, globalId, obj.toString(), stamp)
      }
      if (rows.isNotEmpty()) db.features().insertAll(rows)
      written += rows.size
      if (at == null) at = (body["asOf"] as? JsonPrimitive)?.contentOrNull
      val next = (body["nextCursor"] as? JsonPrimitive)?.contentOrNull
      // A repeated cursor would loop forever; treat it as the end.
      if (next == null || !seen.add(next)) break
      cursor = next
    }
    db.features().deleteStaleForLayer(collectionId, layer.dataLayerId, layer.layerKey, stamp)
    return LayerPull(layer.copy(syncVersion = seeded, syncBboxJson = OfflineDownloadRules.encodeBox(bbox)), written)
  }

  /**
   * Read the layer head via a cheap `delta?since=0&limit=1`, before a
   * full pull. Null when the endpoint is unavailable so the next run
   * retries a full pull + seed.
   */
  private suspend fun seedSyncVersionCursor(dataLayerId: String, layerKey: String): Long? =
    try {
      portal.getLayerDelta(dataLayerId, layerKey, since = 0, limit = 1).syncVersion
    } catch (_: Throwable) {
      rethrowIfCancelled()
      null
    }

  private suspend fun downloadPackage(
    collectionId: String,
    areaId: String,
    packageId: String,
    onProgress: (Long, Long?) -> Unit,
  ): File = withContext(Dispatchers.IO) {
    val dir = File(packageDir, collectionId).apply { mkdirs() }
    val target = File(dir, "$areaId.pmtiles")
    // Written to a temp name and renamed last, so a partial download
    // never becomes the file the map reads.
    val tmp = File(dir, "$areaId.pmtiles.part")
    tmp.outputStream().use { out -> portal.downloadOfflinePackage(collectionId, packageId, out, onProgress) }
    if (target.exists()) target.delete()
    if (!tmp.renameTo(target)) error("Could not move ${tmp.name} into place")
    target
  }

  /**
   * The map's editable layers. A data-layer item that could not be
   * fetched this time (timeout, 5xx, auth) keeps the layer rows the
   * device already has for it, with a shortfall: a weak signal must
   * not silently take a layer, its form binding and its cursor off
   * the device. Only an item the server says is gone (404) is dropped,
   * and that is reported too.
   */
  private suspend fun resolveLayers(
    collection: ItemSummary,
    map: ItemSummary,
    priorLayers: List<LayerEntity>,
    shortfalls: MutableList<String>,
    featureCounts: MutableMap<String, Long>,
  ): List<LayerEntity> {
    val mapData = map.data ?: return emptyList()
    val formBindings = collection.data?.get("formBindings") as? JsonObject
    data class Ref(val dataLayerId: String, val layerKey: String?, val mapLayerEditable: Boolean)
    val refs = LinkedHashMap<String, Ref>()
    for (ml in mapData["layers"]?.jsonArray ?: JsonArray(emptyList())) {
      val source = ml.jsonObject["source"] as? JsonObject ?: continue
      if (source["kind"]?.jsonPrimitive?.contentOrNull != "data-layer") continue
      val itemId = source["itemId"]?.jsonPrimitive?.contentOrNull ?: continue
      val key = source["layerKey"]?.jsonPrimitive?.contentOrNull
      val editable = (ml.jsonObject["interactions"] as? JsonObject)?.get("editingEnabled")?.jsonPrimitive?.booleanOrNull != false
      refs.putIfAbsent("$itemId:${key ?: ""}", Ref(itemId, key, editable))
    }
    val items = HashMap<String, ItemSummary>()
    val unreachable = HashSet<String>()
    for (id in refs.values.map { it.dataLayerId }.distinct()) {
      try {
        items[id] = portal.getItem(id)
      } catch (t: Throwable) {
        rethrowIfCancelled()
        if (t is PortalError.NotFound) {
          shortfalls += "layer ${id.take(8)}: no longer available"
        } else {
          unreachable += id
          shortfalls += "layer ${id.take(8)}: ${t.message}"
        }
      }
    }
    val out = mutableListOf<LayerEntity>()
    val seen = HashSet<String>()
    for (ref in refs.values) {
      if (ref.dataLayerId in unreachable) {
        for (prior in priorLayers.filter { it.dataLayerId == ref.dataLayerId }) {
          if (seen.add("${prior.dataLayerId}:${prior.layerKey}")) out += prior
        }
        continue
      }
      val item = items[ref.dataLayerId] ?: continue
      val data = item.data ?: continue
      if (data["version"]?.jsonPrimitive?.intOrNull != 3) continue
      val sublayers = data["layers"]?.jsonArray ?: continue
      val sub = (
        if (ref.layerKey != null) sublayers.firstOrNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull == ref.layerKey }
        else sublayers.firstOrNull { it.jsonObject["geometryType"]?.jsonPrimitive?.contentOrNull != null }
        )?.jsonObject ?: continue
      val subId = sub["id"]?.jsonPrimitive?.contentOrNull ?: continue
      if (!seen.add("${item.id}:$subId")) continue
      val fields = sub["fields"] ?: JsonArray(emptyList())
      // Stamped on the data_layer item by the import worker and the
      // housekeeping pass; absent on items it has not reached yet.
      (sub["featureCount"] as? JsonPrimitive)?.longOrNull?.let { featureCounts["${item.id}:$subId"] = it }
      out += LayerEntity(
        collectionId = collection.id,
        dataLayerId = item.id,
        layerKey = subId,
        label = sub["label"]?.jsonPrimitive?.contentOrNull ?: subId,
        geometryType = sub["geometryType"]?.jsonPrimitive?.contentOrNull,
        fieldsJson = fields.toString(),
        schemaHash = engine.schemaHash(fields),
        editingPolicy = sub["editingPolicy"]?.jsonPrimitive?.contentOrNull ?: "all-rows",
        addable = sub["editingEnabled"]?.jsonPrimitive?.booleanOrNull != false && ref.mapLayerEditable,
        boundFormItemId = (formBindings?.get(subId) as? JsonObject)?.get("formItemId")?.jsonPrimitive?.contentOrNull,
      )
    }
    return out
  }

  /** Same FNV-1a fallback key as offline-download.ts `stableId`. */
  private fun stableId(f: JsonObject): String {
    val text = kotlinx.serialization.json.buildJsonObject {
      put("geometry", f["geometry"] ?: kotlinx.serialization.json.JsonNull)
      put("properties", f["properties"] ?: kotlinx.serialization.json.JsonNull)
    }.toString()
    var h = 0x811c9dc5L
    for (ch in text) {
      h = h xor ch.code.toLong()
      h = (h + ((h shl 1) + (h shl 4) + (h shl 7) + (h shl 8) + (h shl 24))) and 0xffffffffL
    }
    return "synth:" + h.toString(16).padStart(8, '0')
  }
}
