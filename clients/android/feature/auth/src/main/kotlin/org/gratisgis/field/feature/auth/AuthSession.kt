// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.forms.submitForm
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.parameters
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import org.gratisgis.field.core.network.TokenProvider

/**
 * The sign-in state machine, with no Android in it so it runs under
 * JUnit against a mock token endpoint. The Android side (Custom Tab
 * launch, redirect activity) is in [AuthLauncher] and
 * [AuthCallbackActivity].
 *
 * Flow: [beginSignIn] builds the authorization URL and remembers the
 * verifier; the host opens it; the redirect comes back through
 * [completeSignIn]; afterwards [accessToken] serves the access token
 * and refreshes it on demand, and the Ktor Auth plugin in
 * :core:network calls [refreshAccessToken] on a 401.
 */
class AuthSession(
  private val store: TokenStore,
  private val clientId: String = CLIENT_ID,
  private val redirectUri: String = REDIRECT_URI,
  engine: HttpClientEngine = OkHttp.create(),
  private val clock: () -> Long = System::currentTimeMillis,
) : TokenProvider {

  private val json = Json { ignoreUnknownKeys = true }
  private val http = HttpClient(engine) {
    install(ContentNegotiation) { json(json) }
    install(HttpTimeout) { requestTimeoutMillis = 20_000 }
    expectSuccess = false
  }
  private val refreshLock = Mutex()

  private val _tokens = MutableStateFlow(store.load())

  /** Null when signed out. */
  val tokens: StateFlow<TokenSet?> = _tokens

  val isSignedIn: Boolean get() = _tokens.value != null

  /** Fetch and cache the issuer's discovery document. */
  suspend fun discover(issuer: String): OidcConfig =
    http.get(issuer.trimEnd('/') + "/.well-known/openid-configuration").body()

  /**
   * Build the URL to open in the browser and persist what the redirect
   * will need. Requests `offline_access` so the refresh token is a
   * Keycloak offline session (30 days idle, per infra/keycloak).
   */
  fun beginSignIn(config: OidcConfig): Url {
    val verifier = Pkce.newVerifier()
    val state = Pkce.newState()
    store.savePending(PendingSignIn(verifier = verifier, state = state, issuer = config.issuer))
    return URLBuilder(config.authorizationEndpoint).apply {
      parameters.append("response_type", "code")
      parameters.append("client_id", clientId)
      parameters.append("redirect_uri", redirectUri)
      parameters.append("scope", SCOPES)
      parameters.append("state", state)
      parameters.append("code_challenge", Pkce.challenge(verifier))
      parameters.append("code_challenge_method", "S256")
    }.build()
  }

  /**
   * Handle the redirect. Verifies `state` against the pending sign-in,
   * exchanges the code with the verifier, stores the tokens. Throws
   * [SignInException] on any refusal; the pending record is cleared
   * either way so a stale redirect cannot be replayed.
   */
  suspend fun completeSignIn(redirect: Url): TokenSet {
    val pending = store.loadPending() ?: throw SignInException("No sign-in in progress")
    store.savePending(null)
    val params = redirect.parameters
    params["error"]?.let { err ->
      throw SignInException(params["error_description"] ?: err)
    }
    val state = params["state"] ?: throw SignInException("Redirect carried no state")
    if (state != pending.state) throw SignInException("Redirect state did not match")
    val code = params["code"] ?: throw SignInException("Redirect carried no code")
    val config = discover(pending.issuer)
    val response = http.submitForm(
      url = config.tokenEndpoint,
      formParameters = parameters {
        append("grant_type", "authorization_code")
        append("client_id", clientId)
        append("redirect_uri", redirectUri)
        append("code", code)
        append("code_verifier", pending.verifier)
      },
    )
    if (response.status.value >= 400) {
      throw SignInException("Token exchange failed: ${describe(response.bodyAsText())}")
    }
    val set = TokenSet.from(response.body<TokenResponse>(), clock())
    store.save(set)
    _tokens.value = set
    return set
  }

  /** Forget the session locally. The Keycloak offline session stays
   *  revocable server-side; ending it from the device is later work. */
  fun signOut() {
    store.clear()
    store.savePending(null)
    _tokens.value = null
  }

  override suspend fun accessToken(): String? {
    val current = _tokens.value ?: return null
    if (current.isFresh(clock())) return current.accessToken
    return refreshAccessToken()
  }

  override suspend fun refreshAccessToken(): String? = refreshLock.withLock {
    val current = _tokens.value ?: return null
    // Another caller may have refreshed while we waited for the lock.
    if (current.isFresh(clock())) return current.accessToken
    val refresh = current.refreshToken ?: return signOutAndNull()
    val issuer = current.accessClaims()?.get("iss")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
      ?: return signOutAndNull()
    val config = discover(issuer)
    val response = http.submitForm(
      url = config.tokenEndpoint,
      formParameters = parameters {
        append("grant_type", "refresh_token")
        append("client_id", clientId)
        append("refresh_token", refresh)
      },
    )
    if (response.status.value in 400..499) {
      // invalid_grant: the offline session was revoked or idled out.
      // Anything else 4xx is equally terminal for this token.
      return signOutAndNull()
    }
    if (response.status.value >= 500) {
      // The server is unhappy, not the session. Keep the tokens and
      // let the caller retry later.
      return null
    }
    val r = response.body<TokenResponse>()
    val set = TokenSet.from(r, clock()).let {
      // Keycloak rotates refresh tokens only when configured to; keep
      // the old one when the response omits it.
      if (it.refreshToken == null) it.copy(refreshToken = refresh) else it
    }
    store.save(set)
    _tokens.value = set
    return set.accessToken
  }

  private fun signOutAndNull(): String? {
    signOut()
    return null
  }

  private fun describe(body: String): String =
    runCatching {
      val obj = json.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject
      (obj["error_description"] ?: obj["error"])?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
    }.getOrNull() ?: body.take(200)

  companion object {
    /** The Keycloak client in infra/keycloak/realm-gratis-gis*.json. */
    const val CLIENT_ID = "field-app"
    const val REDIRECT_URI = "gratisgis://auth-callback"
    const val SCOPES = "openid offline_access"
  }
}

class SignInException(message: String) : Exception(message)
