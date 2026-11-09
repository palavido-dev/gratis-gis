// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.coroutines.Dispatchers
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
import org.gratisgis.field.core.database.CollectionEntity
import org.gratisgis.field.core.database.FeatureEntity
import org.gratisgis.field.core.database.FieldDatabase
import org.gratisgis.field.core.database.FormEntity
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.network.ItemSummary
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
)

/**
 * Take a data_collection offline: resolve its map's editable layers,
 * cache their features and schemas, fetch bound forms, and download
 * every ready basemap package. Mirrors `downloadDeployment` in
 * apps/portal-web/src/lib/offline-download.ts, minus pick lists and
 * attachments for now.
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

  suspend fun download(collection: ItemSummary, onProgress: (DownloadProgress) -> Unit) {
    var progress = DownloadProgress(phase = "resolving")
    fun report(p: DownloadProgress) { progress = p; onProgress(p) }
    val shortfalls = mutableListOf<String>()
    val data = collection.data ?: error("Collection ${collection.id} has no data")
    val mapId = data["mapId"]?.jsonPrimitive?.contentOrNull ?: error("Collection has no mapId")

    // Keep prior syncVersion cursors across the layer wipe+reupsert so
    // a refresh can delta instead of re-pulling every feature.
    val priorCursors = db.layers().forCollection(collection.id)
      .associate { "${it.dataLayerId}:${it.layerKey}" to it.syncVersion }

    // Editable layers.
    val map = portal.getItem(mapId)
    val layers = resolveLayers(collection, map).map { layer ->
      val prior = priorCursors["${layer.dataLayerId}:${layer.layerKey}"]
      if (prior != null) layer.copy(syncVersion = prior) else layer
    }
    db.collections().upsert(
      CollectionEntity(
        id = collection.id,
        title = collection.title,
        mapId = mapId,
        dataJson = data.toString(),
        downloadedAt = null,
      ),
    )
    db.layers().deleteForCollection(collection.id)
    db.layers().upsertAll(layers)
    report(progress.copy(phase = "features", layers = layers.size))

    val now = Instant.now().toString()
    var featureCount = 0
    val layersAfter = layers.toMutableList()
    for ((index, layer) in layers.withIndex()) {
      report(progress.copy(detail = layer.label))
      try {
        val cursor = layer.syncVersion
        val updated = if (cursor != null) {
          try {
            pullLayerDelta(collection.id, layer, cursor, now)
          } catch (t: Throwable) {
            // Corrupt / unknown cursor, older server, or transient
            // delta failure: fall back to a full GeoJSON once and
            // re-seed (research R4-android-field-delta).
            if (shouldFallbackToFull(t)) {
              pullFullAndSeed(collection.id, layer, now)
            } else {
              throw t
            }
          }
        } else {
          pullFullAndSeed(collection.id, layer, now)
        }
        layersAfter[index] = updated.layer
        db.layers().upsertAll(listOf(updated.layer))
        featureCount += updated.applied
        report(progress.copy(features = featureCount))
      } catch (t: Throwable) {
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
        shortfalls += "form ${formId.take(8)}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    // Prepared basemap packages: every ready area.
    report(progress.copy(phase = "packages"))
    val areas = portal.listOfflineAreas(collection.id).areas
    for (entry in areas) {
      val current = entry.current ?: continue
      if (current.status != "ready") continue
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
        shortfalls += "package ${entry.area.name}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    db.collections().upsert(
      CollectionEntity(collection.id, collection.title, mapId, data.toString(), downloadedAt = now),
    )
    report(progress.copy(phase = "done", detail = ""))
  }

  private data class LayerPull(val layer: LayerEntity, val applied: Int)

  /** An older server truncated a page that is all one version and
   *  gave no `nextAfter`; paging cannot progress, so pull in full. */
  private class DeltaStalled : IllegalStateException("Delta cannot page past one version on this server")

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
      )
      val (upserts, deletes) = LayerDeltaApply.applyDeltaChanges(
        body.changes,
        collectionId,
        layer.dataLayerId,
        layer.layerKey,
        cachedAt,
      )
      if (upserts.isNotEmpty()) db.features().insertAll(upserts)
      if (deletes.isNotEmpty()) {
        db.features().deleteByGlobalIds(
          collectionId,
          layer.dataLayerId,
          layer.layerKey,
          deletes,
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
   * not the server allows unpaged reads. Rows replace the layer only
   * once every page has arrived.
   */
  private suspend fun pullFullAndSeed(
    collectionId: String,
    layer: LayerEntity,
    now: String,
  ): LayerPull {
    val seeded = seedSyncVersionCursor(layer.dataLayerId, layer.layerKey)
    val rows = mutableListOf<FeatureEntity>()
    var cursor: String? = null
    var at: String? = null
    val seen = HashSet<String>()
    while (true) {
      val text = portal.getLayerGeoJson(
        layer.dataLayerId,
        layer.layerKey,
        limit = FULL_PAGE_LIMIT,
        cursor = cursor,
        at = at,
      )
      val body = json.parseToJsonElement(text).jsonObject
      val features = body["features"]?.jsonArray ?: JsonArray(emptyList())
      features.mapTo(rows) { f ->
        val obj = f.jsonObject
        val props = obj["properties"] as? JsonObject
        val globalId = props?.get("_global_id")?.jsonPrimitive?.contentOrNull
          ?: obj["id"]?.jsonPrimitive?.contentOrNull
          ?: stableId(obj)
        FeatureEntity(collectionId, layer.dataLayerId, layer.layerKey, globalId, obj.toString(), now)
      }
      if (at == null) at = (body["asOf"] as? JsonPrimitive)?.contentOrNull
      val next = (body["nextCursor"] as? JsonPrimitive)?.contentOrNull
      // A repeated cursor would loop forever; treat it as the end.
      if (next == null || !seen.add(next)) break
      cursor = next
    }
    db.features().deleteForLayer(collectionId, layer.dataLayerId, layer.layerKey)
    db.features().insertAll(rows)
    return LayerPull(layer.copy(syncVersion = seeded), rows.size)
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
      null
    }

  private fun shouldFallbackToFull(t: Throwable): Boolean {
    val err = t as? PortalError ?: return true
    // 4xx on delta (Gone / Not Found / bad cursor) → full once.
    // 5xx / auth / rate-limit stay as shortfalls so we don't thrash.
    return err.status in 400..499 && err !is PortalError.Auth && err !is PortalError.RateLimit
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

  private suspend fun resolveLayers(collection: ItemSummary, map: ItemSummary): List<LayerEntity> {
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
    val items = HashMap<String, ItemSummary?>()
    for (id in refs.values.map { it.dataLayerId }.distinct()) {
      items[id] = runCatching { portal.getItem(id) }.getOrNull()
    }
    val out = mutableListOf<LayerEntity>()
    val seen = HashSet<String>()
    for (ref in refs.values) {
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
