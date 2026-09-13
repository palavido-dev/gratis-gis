// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import org.gratisgis.field.core.engine.FieldEngine
import org.gratisgis.field.core.engine.loadFromAssets
import org.gratisgis.field.core.network.PortalClient
import org.gratisgis.field.core.network.PortalInfo
import org.gratisgis.field.feature.auth.AuthSession
import org.gratisgis.field.feature.auth.KeystoreTokenStore

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

  lateinit var auth: AuthSession
    private set

  lateinit var settings: PortalSettings
    private set

  /** The client for the portal the user connected to; null until
   *  discovery has run this process. */
  @Volatile
  var portal: PortalClient? = null
    private set

  override fun onCreate() {
    super.onCreate()
    engine = appScope.async { FieldEngine.loadFromAssets(this@FieldApplication) }
    settings = PortalSettings(this)
    auth = AuthSession(KeystoreTokenStore(this))
  }

  fun connect(info: PortalInfo): PortalClient {
    portal?.close()
    return PortalClient(info.api.baseUrl, auth).also { portal = it }
  }
}

/** Non-secret preferences: which portal this device talks to. */
class PortalSettings(context: Context) {
  private val prefs = context.getSharedPreferences("gratisgis.field.settings", Context.MODE_PRIVATE)

  var portalUrl: String
    get() = prefs.getString("portalUrl", DEFAULT_PORTAL_URL) ?: DEFAULT_PORTAL_URL
    set(value) = prefs.edit().putString("portalUrl", value.trim().trimEnd('/')).apply()

  /** Cached discovery for the portal above, so a cold start offline
   *  still knows the issuer and API base. */
  var portalInfoJson: String?
    get() = prefs.getString("portalInfo", null)
    set(value) = prefs.edit().putString("portalInfo", value).apply()

  companion object {
    const val DEFAULT_PORTAL_URL = "https://gratisgis.org"
  }
}
