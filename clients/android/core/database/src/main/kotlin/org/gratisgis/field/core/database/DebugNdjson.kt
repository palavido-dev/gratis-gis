// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.database

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Agent debug NDJSON logger for draft/offline persistence investigation.
 * Writes to Logcat (tag GGDebug) and app filesDir/debug.log (adb pull).
 * Also attempts /opt/cursor/logs/debug.log when present (host/emulator).
 */
object DebugNdjson {
  private const val TAG = "GGDebug"
  @Volatile private var filesDir: File? = null

  fun init(context: Context) {
    filesDir = context.applicationContext.filesDir
  }

  fun log(hypothesisId: String, location: String, message: String, data: Map<String, Any?> = emptyMap()) {
    val payload = JSONObject()
    payload.put("hypothesisId", hypothesisId)
    payload.put("location", location)
    payload.put("message", message)
    payload.put("timestamp", System.currentTimeMillis())
    val dataObj = JSONObject()
    for ((k, v) in data) dataObj.put(k, v ?: JSONObject.NULL)
    payload.put("data", dataObj)
    val line = payload.toString()
    Log.i(TAG, line)
    // #region agent log
    tryWrite(File("/opt/cursor/logs/debug.log"), line)
    filesDir?.let { tryWrite(File(it, "debug.log"), line) }
    // #endregion
  }

  private fun tryWrite(file: File, line: String) {
    try {
      file.parentFile?.mkdirs()
      file.appendText(line + "\n")
    } catch (_: Throwable) {
      // best-effort only
    }
  }
}
