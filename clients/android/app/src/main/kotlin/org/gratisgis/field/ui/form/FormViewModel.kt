// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.form

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.gratisgis.field.FieldApplication
import org.gratisgis.field.core.database.DraftEntity
import org.gratisgis.field.core.database.FormEntity
import org.gratisgis.field.core.database.LayerEntity
import org.gratisgis.field.core.engine.CallResult
import java.time.Instant
import java.util.UUID

data class FormFieldUi(
  val id: String,
  val type: String,
  val label: String,
  val required: Boolean,
)

data class FormUiState(
  val collectionId: String,
  val formId: String,
  val layerLabel: String,
  val draftId: String,
  val fields: List<FormFieldUi> = emptyList(),
  /** question id → string value (A1: text / integer / select_one as text). */
  val values: Map<String, String> = emptyMap(),
  val busy: Boolean = false,
  val savedAt: String? = null,
  val validationOk: Boolean? = null,
  val validationDetail: String? = null,
  val error: String? = null,
)

/**
 * A1: load a cached bound form, edit responses, validate via field-engine,
 * persist a Room draft that survives process death.
 */
class FormViewModel(
  application: Application,
  private val collectionId: String,
  private val formId: String,
  private val layer: LayerEntity,
  private val existingDraftId: String?,
) : AndroidViewModel(application) {

  private val app get() = getApplication<Application>() as FieldApplication
  private val json = Json { ignoreUnknownKeys = true }

  private val _state = MutableStateFlow(
    FormUiState(
      collectionId = collectionId,
      formId = formId,
      layerLabel = layer.label,
      draftId = existingDraftId ?: UUID.randomUUID().toString(),
    ),
  )
  val state: StateFlow<FormUiState> = _state

  private var formEntity: FormEntity? = null
  private var schema: JsonObject? = null

  init {
    viewModelScope.launch { load() }
  }

  private suspend fun load() {
    _state.update { it.copy(busy = true, error = null) }
    try {
      val form = app.db.forms().get(formId)
        ?: error("Form $formId not cached — download the collection offline first")
      formEntity = form
      val root = json.parseToJsonElement(form.schemaJson).jsonObject
      schema = root
      val fields = parseFields(root)
      var values = fields.associate { it.id to "" }
      val draftId = _state.value.draftId
      val draft = app.db.drafts().get(draftId)
        ?: existingDraftId?.let { app.db.drafts().get(it) }
        ?: app.db.drafts().forCollection(collectionId).firstOrNull { it.formId == formId }
      if (draft != null) {
        val response = json.parseToJsonElement(draft.responseJson).jsonObject
        values = fields.associate { f ->
          f.id to (response[f.id]?.let { stringify(it) } ?: "")
        }
        _state.update {
          it.copy(
            draftId = draft.id,
            fields = fields,
            values = values,
            savedAt = draft.updatedAt,
          )
        }
      } else {
        _state.update { it.copy(fields = fields, values = values) }
      }
    } catch (t: Throwable) {
      _state.update { it.copy(error = t.message ?: t.toString()) }
    } finally {
      _state.update { it.copy(busy = false) }
    }
  }

  fun setValue(fieldId: String, value: String) {
    _state.update { it.copy(values = it.values + (fieldId to value), validationOk = null) }
  }

  fun saveDraft() {
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      try {
        val sch = schema ?: error("Form not loaded")
        val response = buildResponse(_state.value.values, _state.value.fields)
        val engine = app.engine.await()
        val args = buildJsonObject {
          put("form", sch)
          put("response", response)
        }.toString()
        val validated = engine.call("form.validate", args)
        val ok = when (validated) {
          is CallResult.Ok -> {
            val detail = validated.result.toString()
            _state.update { it.copy(validationDetail = detail.take(400)) }
            val obj = validated.result as? JsonObject
            when {
              obj == null -> true
              obj["ok"] is JsonPrimitive ->
                runCatching { obj["ok"]!!.jsonPrimitive.boolean }.getOrElse {
                  obj["ok"]!!.jsonPrimitive.content != "false"
                }
              obj["issues"] is JsonArray -> (obj["issues"] as JsonArray).isEmpty()
              else -> true
            }
          }
          is CallResult.Error -> {
            _state.update { it.copy(validationOk = false, validationDetail = validated.message) }
            false
          }
        }
        val now = Instant.now().toString()
        app.db.drafts().upsert(
          DraftEntity(
            id = _state.value.draftId,
            collectionId = collectionId,
            formId = formId,
            layerKey = layer.layerKey,
            dataLayerId = layer.dataLayerId,
            responseJson = response.toString(),
            updatedAt = now,
          ),
        )
        _state.update {
          it.copy(
            savedAt = now,
            validationOk = ok,
            busy = false,
          )
        }
      } catch (t: Throwable) {
        _state.update { it.copy(busy = false, error = t.message ?: t.toString()) }
      }
    }
  }

  private fun buildResponse(values: Map<String, String>, fields: List<FormFieldUi>): JsonObject =
    buildJsonObject {
      for (f in fields) {
        val raw = values[f.id]?.trim().orEmpty()
        if (raw.isEmpty()) continue
        when (f.type) {
          "integer", "decimal", "number" -> {
            val n = raw.toLongOrNull() ?: raw.toDoubleOrNull()
            if (n != null) put(f.id, JsonPrimitive(n))
            else put(f.id, JsonPrimitive(raw))
          }
          else -> put(f.id, JsonPrimitive(raw))
        }
      }
    }

  private fun parseFields(schema: JsonObject): List<FormFieldUi> {
    val questions = schema["questions"] as? JsonArray ?: return emptyList()
    val out = mutableListOf<FormFieldUi>()
    fun walk(arr: JsonArray) {
      for (el in arr) {
        val q = el as? JsonObject ?: continue
        val type = q["type"]?.jsonPrimitive?.contentOrNull ?: continue
        if (type == "group") {
          (q["children"] as? JsonArray)?.let { walk(it) }
          continue
        }
        // A1: render a useful subset; skip media/geo for later milestones.
        if (type in SKIP_TYPES) continue
        val id = q["id"]?.jsonPrimitive?.contentOrNull ?: continue
        val label = q["label"]?.jsonPrimitive?.contentOrNull ?: id
        val required = when (val r = q["required"]) {
          is JsonPrimitive -> runCatching { r.boolean }.getOrElse { r.content.equals("true", ignoreCase = true) }
          else -> false
        }
        out += FormFieldUi(id = id, type = type, label = label, required = required)
      }
    }
    walk(questions)
    return out
  }

  private fun stringify(el: JsonElement): String =
    when (el) {
      is JsonNull -> ""
      is JsonPrimitive -> el.content
      else -> el.toString()
    }

  companion object {
    private val SKIP_TYPES = setOf(
      "geopoint", "geotrace", "geoshape", "image", "audio", "video", "file",
      "acknowledge", "note", "rank", "hidden",
    )
  }
}
