// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.gratisgis.field.core.database.CollectionEntity
import org.gratisgis.field.core.database.FeatureEntity
import org.gratisgis.field.core.database.FieldDatabase
import org.gratisgis.field.core.database.FormEntity
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.network.ItemSummary
import org.gratisgis.field.core.network.PortalClient
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

  suspend fun download(collection: ItemSummary, onProgress: (DownloadProgress) -> Unit) {
    var progress = DownloadProgress(phase = "resolving")
    fun report(p: DownloadProgress) { progress = p; onProgress(p) }
    val shortfalls = mutableListOf<String>()
    val data = collection.data ?: error("Collection ${collection.id} has no data")
    val mapId = data["mapId"]?.jsonPrimitive?.contentOrNull ?: error("Collection has no mapId")

    // Editable layers.
    val map = portal.getItem(mapId)
    val layers = resolveLayers(collection, map)
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

    // Features, per layer, whole layer (the bbox scoping the web
    // runtime does comes with the map viewport later).
    val now = Instant.now().toString()
    var featureCount = 0
    for (layer in layers) {
      report(progress.copy(detail = layer.label))
      try {
        val text = portal.getLayerGeoJson(layer.dataLayerId, layer.layerKey)
        val features = json.parseToJsonElement(text).jsonObject["features"]?.jsonArray ?: JsonArray(emptyList())
        val rows = features.map { f ->
          val obj = f.jsonObject
          val props = obj["properties"] as? JsonObject
          val globalId = props?.get("_global_id")?.jsonPrimitive?.contentOrNull
            ?: obj["id"]?.jsonPrimitive?.contentOrNull
            ?: stableId(obj)
          FeatureEntity(collection.id, layer.dataLayerId, layer.layerKey, globalId, obj.toString(), now)
        }
        db.features().deleteForLayer(collection.id, layer.dataLayerId, layer.layerKey)
        db.features().insertAll(rows)
        featureCount += rows.size
        report(progress.copy(features = featureCount))
      } catch (t: Throwable) {
        shortfalls += "${layer.label}: ${t.message}"
        report(progress.copy(shortfalls = shortfalls.toList()))
      }
    }

    // Bound forms.
    report(progress.copy(phase = "forms"))
    var formCount = 0
    for (formId in layers.mapNotNull { it.boundFormItemId }.distinct()) {
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
