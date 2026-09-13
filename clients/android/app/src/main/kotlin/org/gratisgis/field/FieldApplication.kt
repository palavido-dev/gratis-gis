// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.engine.loadFromAssets

/**
 * Process-wide singletons. The engine is loaded once at process start
 * and shared: it owns a native runtime, and every screen that needs a
 * decision about a form or a queued edit goes through the same one.
 * No DI framework yet; when the module count justifies one this is
 * the seam it replaces.
 */
class FieldApplication : Application() {

  private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  /** Resolves once the bundle is verified and evaluated. A failure here
   *  is fatal to the app's purpose and surfaces on the first screen. */
  lateinit var engine: Deferred<FieldEngine>
    private set

  override fun onCreate() {
    super.onCreate()
    engine = appScope.async { FieldEngine.loadFromAssets(this@FieldApplication) }
  }
}
