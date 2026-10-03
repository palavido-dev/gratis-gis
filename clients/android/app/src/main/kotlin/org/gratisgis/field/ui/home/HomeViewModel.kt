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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.gratisgis.field.FieldApplication
import org.gratisgis.field.core.database.CollectionEntity
import org.gratisgis.field.core.network.ItemSummary
import org.gratisgis.field.core.network.PortalError
import org.gratisgis.field.core.network.PortalClient
import org.gratisgis.field.core.network.PortalInfo
import org.gratisgis.field.feature.auth.AuthLauncher
import org.gratisgis.field.feature.auth.SignInException

/**
 * Connect to a portal, sign in, list data_collection items.
 *
 * The network catalogue is merged with Room's offline cache so a
 * force-stop / airplane-mode cold start still shows deployments the
 * device already downloaded (with drafts and basemap packages intact).
 */
data class HomeState(
  val portalUrl: String,
  val portal: PortalInfo? = null,
  val busy: Boolean = false,
  val signedInAs: String? = null,
  val collections: List<ItemSummary> = emptyList(),
  /** Collection ids that have a Room download (offline-ready). */
  val downloadedIds: Set<String> = emptySet(),
  /** Draft counts keyed by collection id (from Room). */
  val draftCounts: Map<String, Int> = emptyMap(),
  /** The collection whose screen is open, or null for the list. */
  val selected: ItemSummary? = null,
  val engineVersion: Int? = null,
  val engineError: String? = null,
  val error: String? = null,
  /** True when the list is Room-only because the network call failed. */
  val offlineCatalogue: Boolean = false,
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
      } else {
        // Still surface Room offline copies so drafts/packages are reachable
        // after a force-stop that left tokens expired.
        viewModelScope.launch { showRoomCatalogue(networkError = "Sign in to refresh the catalogue") }
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
    _state.update {
      it.copy(signedInAs = null, collections = emptyList(), selected = null, error = null, offlineCatalogue = false)
    }
    // Keep Room data; re-show offline copies after sign-out so nothing
    // looks "wiped" — user can sign in again to sync.
    viewModelScope.launch { showRoomCatalogue(networkError = null) }
  }

  fun loadCollections() {
    viewModelScope.launch {
      _state.update { it.copy(busy = true, error = null) }
      val roomMeta = loadRoomMeta()
      // Paint Room first so a slow/flaky network never hides offline work.
      if (roomMeta.summaries.isNotEmpty()) {
        _state.update {
          it.copy(
            collections = roomMeta.summaries,
            downloadedIds = roomMeta.downloadedIds,
            draftCounts = roomMeta.draftCounts,
            offlineCatalogue = true,
          )
        }
      }
      val client = app.portal
      if (client == null) {
        showRoomCatalogue(networkError = "Not connected to a portal")
        _state.update { it.copy(busy = false) }
        return@launch
      }
      try {
        val network = client.listCollections()
        val merged = mergeCatalogue(network, roomMeta.summaries)
        _state.update {
          it.copy(
            collections = merged,
            downloadedIds = roomMeta.downloadedIds,
            draftCounts = roomMeta.draftCounts,
            offlineCatalogue = false,
            error = null,
          )
        }
      } catch (t: Throwable) {
        if (t is PortalError.Auth && !app.auth.isSignedIn) {
          _state.update { it.copy(signedInAs = null) }
        }
        showRoomCatalogue(networkError = describe(t))
      } finally {
        _state.update { it.copy(busy = false) }
      }
    }
  }

  private suspend fun showRoomCatalogue(networkError: String?) {
    val roomMeta = loadRoomMeta()
    _state.update {
      it.copy(
        collections = roomMeta.summaries,
        downloadedIds = roomMeta.downloadedIds,
        draftCounts = roomMeta.draftCounts,
        offlineCatalogue = roomMeta.summaries.isNotEmpty(),
        error = networkError,
      )
    }
  }

  private data class RoomMeta(
    val summaries: List<ItemSummary>,
    val downloadedIds: Set<String>,
    val draftCounts: Map<String, Int>,
  )

  private suspend fun loadRoomMeta(): RoomMeta {
    val rows = app.db.collections().all()
    val downloaded = rows.mapNotNull { r -> r.id.takeIf { r.downloadedAt != null } }.toSet()
    val drafts = mutableMapOf<String, Int>()
    for (r in rows) {
      val n = app.db.drafts().forCollection(r.id).size
      if (n > 0) drafts[r.id] = n
    }
    return RoomMeta(
      summaries = rows.map { it.toSummary() },
      downloadedIds = downloaded,
      draftCounts = drafts,
    )
  }

  private fun CollectionEntity.toSummary(): ItemSummary {
    val data = runCatching { json.parseToJsonElement(dataJson).jsonObject }.getOrNull()
    val offlineBit = when {
      downloadedAt != null -> "On device · downloaded $downloadedAt"
      else -> "On device (partial)"
    }
    return ItemSummary(
      id = id,
      title = title,
      type = "data_collection",
      description = offlineBit,
      data = data,
    )
  }

  /**
   * Network rows win for title/description metadata; Room supplies
   * `data` when the network list omitted it, and Room-only ids stay
   * visible (still offline after the server removed the item).
   */
  private fun mergeCatalogue(network: List<ItemSummary>, room: List<ItemSummary>): List<ItemSummary> {
    val roomById = room.associateBy { it.id }
    val out = LinkedHashMap<String, ItemSummary>()
    for (n in network) {
      val cached = roomById[n.id]
      out[n.id] = when {
        cached == null -> n
        n.data == null && cached.data != null -> n.copy(data = cached.data)
        else -> n
      }
    }
    for (r in room) {
      if (!out.containsKey(r.id)) out[r.id] = r
    }
    return out.values.sortedBy { it.title.lowercase() }
  }

  private fun describe(t: Throwable): String = when (t) {
    is PortalError -> "${t.status}: ${t.message}"
    is SignInException -> "Sign-in failed: ${t.message}"
    else -> t.message ?: t.toString()
  }
}
