// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.collection

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.gratisgis.field.FieldApplication
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.database.OfflinePackageEntity
import org.gratisgis.field.core.database.QueueEntity
import org.gratisgis.field.core.engine.CallResult
import org.gratisgis.field.core.network.ItemSummary
import org.gratisgis.field.feature.sync.DownloadProgress
import org.gratisgis.field.feature.sync.EnqueueResult
import org.gratisgis.field.feature.sync.FeatureEdit
import org.gratisgis.field.feature.sync.FeatureQueue
import org.gratisgis.field.feature.sync.OfflineDownloader
import org.gratisgis.field.feature.sync.QueueDrain
import org.gratisgis.field.feature.sync.SyncResult
import java.time.Instant
import java.util.UUID

data class CollectionState(
  val collection: ItemSummary,
  val busy: Boolean = false,
  val layers: List<LayerEntity> = emptyList(),
  val featureCount: Int = 0,
  val packages: List<OfflinePackageEntity> = emptyList(),
  val downloadedAt: String? = null,
  val progress: DownloadProgress? = null,
  val queue: List<QueueEntity> = emptyList(),
  val lastSync: SyncResult? = null,
  val benchmark: String? = null,
  val error: String? = null,
)

/**
 * Skeleton actions for one collection: take it offline, queue a test
 * record, drain the queue, time the engine. Each is one button; the
 * real screens replace the buttons, not the calls behind them.
 */
class CollectionViewModel(application: Application, collection: ItemSummary) : AndroidViewModel(application) {

  private val app get() = getApplication<Application>() as FieldApplication
  private val json = Json { ignoreUnknownKeys = true }

  private val _state = MutableStateFlow(CollectionState(collection))
  val state: StateFlow<CollectionState> = _state

  init {
    refresh()
  }

  fun refresh() {
    viewModelScope.launch {
      val id = _state.value.collection.id
      val stored = app.db.collections().get(id)
      _state.update {
        it.copy(
          layers = app.db.layers().forCollection(id),
          featureCount = app.db.features().countForCollection(id),
          packages = app.db.offlinePackages().forCollection(id),
          downloadedAt = stored?.downloadedAt,
          queue = app.db.queue().forCollection(id),
        )
      }
    }
  }

  fun download() {
    val portal = app.portal ?: return fail("Not connected")
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null, progress = null) }
      try {
        val downloader = OfflineDownloader(portal, app.db, app.engine.await(), app.packageDir)
        downloader.download(_state.value.collection) { p -> _state.update { it.copy(progress = p) } }
      } catch (t: Throwable) {
        fail(t.message ?: t.toString())
      } finally {
        _state.update { it.copy(busy = false) }
        refresh()
      }
    }
  }

  /**
   * Queue an insert on the first addable point layer: a point at the
   * centre of the first downloaded area (or 0,0), attributes empty.
   * Whether the server accepts it is the point of the exercise; a
   * layer with required fields produces a rejected row, which is the
   * `3a` path.
   */
  fun queueTestRecord() {
    viewModelScope.launch {
      _state.update { it.copy(error = null) }
      try {
        val s = _state.value
        val layer = s.layers.firstOrNull { it.addable && it.geometryType?.contains("Point") == true }
          ?: s.layers.firstOrNull { it.addable }
          ?: return@launch fail("No addable layer; download the collection first")
        val userId = app.auth.tokens.value?.subject ?: return@launch fail("Signed out")
        // Centre of the first declared offline area, so the record lands
        // where the crew works and not in the Gulf of Guinea.
        val bbox = (s.collection.data?.get("offlineAreas") as? kotlinx.serialization.json.JsonArray)
          ?.firstOrNull()?.jsonObject?.get("bbox")?.jsonArray
          ?.map { it.jsonPrimitive.content.toDouble() }
          ?.takeIf { it.size == 4 }
        val lon = bbox?.let { (it[0] + it[2]) / 2 } ?: 0.0
        val lat = bbox?.let { (it[1] + it[3]) / 2 } ?: 0.0
        val geometry = buildJsonObject {
          put("type", "Point")
          put("coordinates", buildJsonArray { add(JsonPrimitive(lon)); add(JsonPrimitive(lat)) })
        }
        val engine = app.engine.await()
        val fields = json.parseToJsonElement(layer.fieldsJson)
        // Fill the server-stamped columns the layer declares, as the
        // web runtime does before it queues; the server replaces them
        // on create anyway, but the schema validator below would
        // otherwise report `submitted_at` as a missing required field.
        val stamped = when (
          val r = engine.call(
            "feature.stamp",
            buildJsonObject {
              put("fields", fields)
              put("properties", buildJsonObject {})
              put("context", buildJsonObject {
                put("userId", userId)
                put("capturedAt", Instant.now().toString())
              })
            },
          )
        ) {
          is CallResult.Ok -> r.result.jsonObject
          is CallResult.Error -> return@launch fail("${r.code}: ${r.message}")
        }
        // The same validation the server will run, before it is queued.
        val validation = engine.call(
          "feature.validate",
          buildJsonObject {
            put("fields", fields)
            put("properties", stamped)
            put("options", buildJsonObject { put("mode", "create") })
          },
        )
        val preview = when (validation) {
          is CallResult.Ok -> validation.result.jsonObject.getValue("violations").jsonArray
            .joinToString("; ") { it.jsonObject.getValue("message").jsonPrimitive.content }
          is CallResult.Error -> validation.message
        }
        val result = FeatureQueue(app.db, engine).enqueue(
          FeatureEdit(
            collectionId = s.collection.id,
            op = "insert",
            dataLayerId = layer.dataLayerId,
            layerKey = layer.layerKey,
            globalId = UUID.randomUUID().toString(),
            geometry = geometry,
            properties = stamped,
            schemaHash = layer.schemaHash,
            ownerUserId = userId,
          ),
        )
        val note = when (result) {
          is EnqueueResult.Queued -> "queued ${result.row.id.take(8)} on ${layer.label}"
          is EnqueueResult.Folded -> "folded into ${result.row.id.take(8)}"
          is EnqueueResult.Annihilated -> "annihilated"
        }
        _state.update { it.copy(error = if (preview.isBlank()) note else "$note (server will say: $preview)") }
      } catch (t: Throwable) {
        fail(t.message ?: t.toString())
      } finally {
        refresh()
      }
    }
  }

  /**
   * Queue an attribute edit on a cached feature of the first addable
   * layer. `stale = false` sends the `_observation_id` the cache holds,
   * which the server accepts. `stale = true` sends a made-up one, so
   * the server answers 409 and the row parks with the server's
   * current version attached: the `3a` review path, provoked on
   * purpose.
   */
  fun queueTestEdit(stale: Boolean) {
    viewModelScope.launch {
      _state.update { it.copy(error = null) }
      try {
        val s = _state.value
        val layer = s.layers.firstOrNull { it.addable } ?: return@launch fail("No addable layer; download first")
        val userId = app.auth.tokens.value?.subject ?: return@launch fail("Signed out")
        val cached = app.db.features().firstForLayer(s.collection.id, layer.dataLayerId, layer.layerKey)
          ?: return@launch fail("No cached features on ${layer.label}")
        val feature = json.parseToJsonElement(cached.featureJson).jsonObject
        val props = feature.getValue("properties").jsonObject
        val base = if (stale) UUID.randomUUID().toString()
        else props["_observation_id"]?.jsonPrimitive?.content ?: return@launch fail("Cached feature has no _observation_id; re-download")
        // Touch one declared, non-server-stamped field with a marker.
        val fields = json.parseToJsonElement(layer.fieldsJson).jsonArray
        val target = fields.map { it.jsonObject }
          .firstOrNull { f ->
            f.getValue("type").jsonPrimitive.content == "string" &&
              f.getValue("name").jsonPrimitive.content !in setOf("submitted_by", "submitted_at", "schema_version")
          }?.getValue("name")?.jsonPrimitive?.content
          ?: return@launch fail("No string field to edit on ${layer.label}")
        val properties = buildJsonObject {
          for ((k, v) in props) if (!k.startsWith("_")) put(k, v)
          put(target, "edited from field app ${Instant.now()}")
        }
        val result = FeatureQueue(app.db, app.engine.await()).enqueue(
          FeatureEdit(
            collectionId = s.collection.id,
            op = "update",
            dataLayerId = layer.dataLayerId,
            layerKey = layer.layerKey,
            globalId = cached.globalId,
            geometry = null,
            properties = properties,
            schemaHash = layer.schemaHash,
            ownerUserId = userId,
            baseObservationId = base,
          ),
        )
        val note = when (result) {
          is EnqueueResult.Queued -> "queued update of ${cached.globalId.take(8)} (base ${base.take(8)}${if (stale) ", stale on purpose" else ""})"
          is EnqueueResult.Folded -> "folded into ${result.row.id.take(8)}"
          is EnqueueResult.Annihilated -> "annihilated"
        }
        _state.update { it.copy(error = note) }
      } catch (t: Throwable) {
        fail(t.message ?: t.toString())
      } finally {
        refresh()
      }
    }
  }

  fun syncNow() {
    val portal = app.portal ?: return fail("Not connected")
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      try {
        val userId = app.auth.tokens.value?.subject ?: return@launch fail("Signed out")
        val result = QueueDrain(app.db, app.engine.await(), portal).drain(_state.value.collection.id, userId, manual = true)
        _state.update { it.copy(lastSync = result) }
      } catch (t: Throwable) {
        fail(t.message ?: t.toString())
      } finally {
        _state.update { it.copy(busy = false) }
        refresh()
      }
    }
  }

  fun discardRejected(row: QueueEntity) {
    viewModelScope.launch {
      app.db.queue().delete(row.collectionId, row.id)
      refresh()
    }
  }

  /**
   * Time the two calls a form renderer makes per keystroke against a
   * realistic form: 25 questions, half with expressions, one repeat
   * group with three instances. Median and p95 over 200 calls each,
   * after 20 warm-up calls.
   */
  fun benchmark() {
    viewModelScope.launch {
      _state.update { it.copy(busy = true, benchmark = null) }
      try {
        val engine = app.engine.await()
        val form = buildJsonObject {
          put("schemaVersion", 1)
          put("id", "bench")
          put("title", "Bench")
          put("questions", buildJsonArray {
            for (i in 1..25) {
              add(buildJsonObject {
                put("id", "q$i")
                put("type", if (i % 3 == 0) "integer" else "text")
                put("label", "Question $i")
                if (i % 2 == 0) {
                  put("visibleIf", buildJsonObject {
                    put("op", "neq")
                    put("left", buildJsonObject { put("ref", "q${i - 1}") })
                    put("right", buildJsonObject { put("value", "") })
                  })
                }
                if (i % 5 == 0) {
                  put("required", true)
                  put("constraint", buildJsonObject {
                    put("op", "gte")
                    put("left", buildJsonObject { put("call", "len"); put("args", buildJsonArray { add(buildJsonObject { put("ref", "q$i") }) }) })
                    put("right", buildJsonObject { put("value", 1) })
                  })
                }
              })
            }
            add(buildJsonObject {
              put("id", "insp")
              put("type", "group")
              put("label", "Inspections")
              put("repeat", buildJsonObject {})
              put("children", buildJsonArray {
                add(buildJsonObject { put("id", "note"); put("type", "text"); put("label", "Note"); put("required", true) })
                add(buildJsonObject { put("id", "score"); put("type", "integer"); put("label", "Score") })
              })
            })
          })
        }
        val response = buildJsonObject {
          for (i in 1..25) put("q$i", if (i % 3 == 0) JsonPrimitive(i) else JsonPrimitive("value $i"))
          put("insp", buildJsonArray { repeat(3) { add(buildJsonObject { put("note", "n"); put("score", 3) }) } })
        }
        val args = buildJsonObject { put("form", form); put("response", response) }
        fun stats(samples: List<Long>): String {
          val s = samples.sorted()
          val med = s[s.size / 2] / 1_000_000.0
          val p95 = s[(s.size * 95) / 100] / 1_000_000.0
          return "median %.2f ms, p95 %.2f ms".format(med, p95)
        }
        val lines = mutableListOf<String>()
        for (name in listOf("form.state", "form.validate", "form.applyCalculations")) {
          repeat(20) { engine.call(name, args) }
          val samples = (1..200).map {
            val t0 = System.nanoTime()
            engine.call(name, args)
            System.nanoTime() - t0
          }
          lines += "$name: ${stats(samples)}"
        }
        _state.update { it.copy(benchmark = lines.joinToString("\n")) }
      } catch (t: Throwable) {
        fail(t.message ?: t.toString())
      } finally {
        _state.update { it.copy(busy = false) }
      }
    }
  }

  private fun fail(message: String) {
    _state.update { it.copy(error = message) }
  }
}
