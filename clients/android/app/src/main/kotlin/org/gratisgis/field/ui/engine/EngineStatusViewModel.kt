// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.engine

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.gratisgis.field.FieldApplication
import org.gratisgis.field.core.engine.CallResult
import org.gratisgis.field.core.engine.FieldEngine

sealed interface EngineStatus {
  data object Loading : EngineStatus
  data class Failed(val message: String) : EngineStatus
  data class Ready(
    val engineVersion: Int,
    val sha256: String,
    val functions: Int,
    val sample: String? = null,
  ) : EngineStatus
}

class EngineStatusViewModel(application: Application) : AndroidViewModel(application) {

  private val _state = MutableStateFlow<EngineStatus>(EngineStatus.Loading)
  val state: StateFlow<EngineStatus> = _state

  private suspend fun engine(): FieldEngine = (getApplication<Application>() as FieldApplication).engine.await()

  init {
    viewModelScope.launch {
      _state.value = try {
        val e = engine()
        EngineStatus.Ready(e.info.engineVersion, e.info.sha256, e.info.functions.size)
      } catch (t: Throwable) {
        EngineStatus.Failed(t.message ?: t.toString())
      }
    }
  }

  /** A required integer with a constraint, answered with -1: the same
   *  two refusals the server would produce. */
  fun runSampleValidation() {
    val ready = _state.value as? EngineStatus.Ready ?: return
    viewModelScope.launch {
      val args = buildJsonObject {
        putJsonObject("form") {
          put("schemaVersion", 1)
          put("id", "sample")
          put("title", "Sample")
          putJsonArray("questions") {
            add(buildJsonObject {
              put("id", "count")
              put("type", "integer")
              put("label", "Count")
              putJsonObject("constraint") {
                put("op", "gte")
                putJsonObject("left") { put("ref", "count") }
                putJsonObject("right") { put("value", 0) }
              }
            })
            add(buildJsonObject {
              put("id", "name")
              put("type", "text")
              put("label", "Name")
              put("required", true)
            })
          }
        }
        putJsonObject("response") { put("count", -1) }
      }
      val text = when (val r = engine().call("form.validate", args)) {
        is CallResult.Ok -> {
          val errors = r.result.jsonObject.getValue("errors").jsonArray
          errors.joinToString("\n") { e ->
            val o = e.jsonObject
            "${o.getValue("questionId").jsonPrimitive.content}: ${o.getValue("message").jsonPrimitive.content}"
          }.ifEmpty { "valid" }
        }
        is CallResult.Error -> "${r.code}: ${r.message}"
      }
      _state.value = ready.copy(sample = text)
    }
  }
}
