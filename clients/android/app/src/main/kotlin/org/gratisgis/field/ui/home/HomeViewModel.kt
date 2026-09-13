// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.ktor.http.Url
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.gratisgis.field.FieldApplication
import org.gratisgis.field.core.network.ItemSummary
import org.gratisgis.field.core.network.PortalError
import org.gratisgis.field.core.network.PortalClient
import org.gratisgis.field.core.network.PortalInfo
import org.gratisgis.field.feature.auth.AuthLauncher
import org.gratisgis.field.feature.auth.SignInException

/**
 * The skeleton's one screen: connect to a portal, sign in, list the
 * data_collection items the account can see. Everything here is
 * orchestration; the decisions (what a valid record is, what to sync)
 * live in the engine bundle and are not reached yet.
 */
data class HomeState(
  val portalUrl: String,
  val portal: PortalInfo? = null,
  val busy: Boolean = false,
  val signedInAs: String? = null,
  val collections: List<ItemSummary> = emptyList(),
  /** The collection whose screen is open, or null for the list. */
  val selected: ItemSummary? = null,
  val engineVersion: Int? = null,
  val engineError: String? = null,
  val error: String? = null,
)

class HomeViewModel(application: Application) : AndroidViewModel(application) {

  private val app get() = getApplication<Application>() as FieldApplication
  private val json = Json { ignoreUnknownKeys = true }

  private val _state = MutableStateFlow(HomeState(portalUrl = app.settings.portalUrl))
  val state: StateFlow<HomeState> = _state

  init {
    viewModelScope.launch {
      try {
        _state.update { it.copy(engineVersion = app.engine.await().info.engineVersion) }
      } catch (t: Throwable) {
        _state.update { it.copy(engineError = t.message ?: t.toString()) }
      }
    }
    // A previous session: restore the cached portal and list straight
    // away. Discovery is skipped so this works offline too.
    val cached = app.settings.portalInfoJson?.let { runCatching { json.decodeFromString(PortalInfo.serializer(), it) }.getOrNull() }
    if (cached != null) {
      _state.update { it.copy(portal = cached) }
      app.connect(cached)
      if (app.auth.isSignedIn) {
        _state.update { it.copy(signedInAs = app.auth.tokens.value?.username) }
        loadCollections()
      }
    }
  }

  fun setPortalUrl(url: String) {
    _state.update { it.copy(portalUrl = url, error = null) }
  }

  /** Discover the portal, then open the browser for sign-in. */
  fun signIn() {
    val url = _state.value.portalUrl.trim().trimEnd('/')
    if (url.isEmpty()) return
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      try {
        val info = PortalClient.discover(url)
        app.settings.portalUrl = url
        app.settings.portalInfoJson = json.encodeToString(PortalInfo.serializer(), info)
        app.connect(info)
        _state.update { it.copy(portal = info, portalUrl = url) }
        val config = app.auth.discover(info.auth.issuer)
        AuthLauncher.open(app, app.auth.beginSignIn(config))
      } catch (t: Throwable) {
        _state.update { it.copy(error = describe(t)) }
      } finally {
        _state.update { it.copy(busy = false) }
      }
    }
  }

  fun completeSignIn(redirect: String) {
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      try {
        val tokens = app.auth.completeSignIn(Url(redirect))
        _state.update { it.copy(signedInAs = tokens.username ?: tokens.subject) }
        loadCollections()
      } catch (t: Throwable) {
        _state.update { it.copy(error = describe(t)) }
      } finally {
        _state.update { it.copy(busy = false) }
      }
    }
  }

  fun select(item: ItemSummary?) {
    _state.update { it.copy(selected = item) }
  }

  fun signOut() {
    app.auth.signOut()
    _state.update { it.copy(signedInAs = null, collections = emptyList(), selected = null, error = null) }
  }

  fun loadCollections() {
    val client = app.portal ?: return
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      try {
        val rows = client.listCollections()
        _state.update { it.copy(collections = rows) }
      } catch (t: Throwable) {
        if (t is PortalError.Auth && !app.auth.isSignedIn) {
          _state.update { it.copy(signedInAs = null, collections = emptyList()) }
        }
        _state.update { it.copy(error = describe(t)) }
      } finally {
        _state.update { it.copy(busy = false) }
      }
    }
  }

  private fun describe(t: Throwable): String = when (t) {
    is PortalError -> "${t.status}: ${t.message}"
    is SignInException -> "Sign-in failed: ${t.message}"
    else -> t.message ?: t.toString()
  }
}
