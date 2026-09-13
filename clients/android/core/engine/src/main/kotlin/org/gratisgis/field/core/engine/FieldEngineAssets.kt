// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.engine

import android.content.Context
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Android entry point: load the bundle the APK ships as an asset and
 * check it against the hash the build recorded in BuildConfig.
 */
suspend fun FieldEngine.Companion.loadFromAssets(
  context: Context,
  dispatcher: CoroutineDispatcher = Dispatchers.Default,
): FieldEngine {
  val source = withContext(Dispatchers.IO) {
    context.assets.open(FieldEngine.BUNDLE_FILE_NAME).bufferedReader(Charsets.UTF_8).use { it.readText() }
  }
  return fromSource(
    source = source,
    expectedSha256 = BuildConfig.FIELD_ENGINE_SHA256,
    dispatcher = dispatcher,
  )
}
