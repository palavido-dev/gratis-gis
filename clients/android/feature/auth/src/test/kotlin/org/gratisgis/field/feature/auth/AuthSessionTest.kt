// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.ktor.http.parseUrlEncodedParameters
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

class AuthSessionTest {

  private val issuer = "https://auth.example/realms/gratis-gis"
  private val discovery = """
    {"issuer":"$issuer",
     "authorization_endpoint":"$issuer/protocol/openid-connect/auth",
     "token_endpoint":"$issuer/protocol/openid-connect/token",
     "end_session_endpoint":"$issuer/protocol/openid-connect/logout",
     "jwks_uri":"$issuer/protocol/openid-connect/certs"}
  """.trimIndent()
  private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")

  /** An unsigned JWT with the claims the app reads. */
  private fun jwt(sub: String = "u1", iss: String = issuer, expSec: Long = 9_999_999_999): String {
    val enc = Base64.getUrlEncoder().withoutPadding()
    val header = enc.encodeToString("""{"alg":"RS256","typ":"JWT"}""".toByteArray())
    val payload = enc.encodeToString(
      """{"sub":"$sub","iss":"$iss","preferred_username":"matt","org_role":"admin","exp":$expSec}""".toByteArray(),
    )
    return "$header.$payload.sig"
  }

  private fun tokenJson(access: String, refresh: String? = "r1", expiresIn: Long = 300) =
    """{"access_token":"$access",${if (refresh != null) "\"refresh_token\":\"$refresh\"," else ""}"expires_in":$expiresIn,"token_type":"Bearer","scope":"openid offline_access"}"""

  private suspend fun HttpRequestData.form(): Map<String, String> {
    val content = body as OutgoingContent.ByteArrayContent
    return content.bytes().toString(Charsets.UTF_8).parseUrlEncodedParameters().entries()
      .associate { (k, v) -> k to v.first() }
  }

  @Test
  fun pkceMatchesTheRfcVector() {
    assertEquals(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    )
    val v = Pkce.newVerifier()
    assertEquals(43, v.length)
    assertTrue(v.all { it.isLetterOrDigit() || it == '-' || it == '_' })
  }

  @Test
  fun signInRoundTrip() = runTest {
    val store = InMemoryTokenStore()
    var exchange: Map<String, String>? = null
    val engine = MockEngine { req ->
      when {
        req.url.toString().endsWith("/.well-known/openid-configuration") -> respond(discovery, HttpStatusCode.OK, jsonHeaders)
        req.url.toString().endsWith("/token") -> {
          exchange = req.form()
          respond(tokenJson(jwt()), HttpStatusCode.OK, jsonHeaders)
        }
        else -> fail("unexpected ${req.url}") as Nothing
      }
    }
    val now = 1_000_000L
    val session = AuthSession(store, engine = engine, clock = { now })
    assertFalse(session.isSignedIn)

    val config = session.discover(issuer)
    val url = session.beginSignIn(config)
    val p = url.parameters
    assertEquals("$issuer/protocol/openid-connect/auth", url.toString().substringBefore('?'))
    assertEquals("code", p["response_type"])
    assertEquals("field-app", p["client_id"])
    assertEquals("gratisgis://auth-callback", p["redirect_uri"])
    assertEquals("openid offline_access", p["scope"])
    assertEquals("S256", p["code_challenge_method"])
    val pending = store.loadPending()!!
    assertEquals(Pkce.challenge(pending.verifier), p["code_challenge"])
    assertEquals(pending.state, p["state"])

    val set = session.completeSignIn(Url("gratisgis://auth-callback?state=${pending.state}&code=abc&session_state=x"))
    assertEquals("authorization_code", exchange!!["grant_type"])
    assertEquals("abc", exchange!!["code"])
    assertEquals(pending.verifier, exchange!!["code_verifier"])
    assertEquals("gratisgis://auth-callback", exchange!!["redirect_uri"])
    assertEquals("r1", set.refreshToken)
    assertEquals(now + 300_000, set.expiresAtMs)
    assertEquals("matt", set.username)
    assertEquals("admin", set.orgRole)
    assertTrue(session.isSignedIn)
    assertNull(store.loadPending())
    assertEquals(set, store.load())
    assertEquals(set.accessToken, session.accessToken())
  }

  @Test
  fun rejectsAMismatchedStateAndClearsThePendingSignIn() = runTest {
    val store = InMemoryTokenStore()
    val engine = MockEngine { respond(discovery, HttpStatusCode.OK, jsonHeaders) }
    val session = AuthSession(store, engine = engine)
    session.beginSignIn(session.discover(issuer))
    try {
      session.completeSignIn(Url("gratisgis://auth-callback?state=forged&code=abc"))
      fail("expected SignInException")
    } catch (e: SignInException) {
      assertTrue(e.message!!.contains("state"))
    }
    assertNull(store.loadPending())
    assertFalse(session.isSignedIn)
  }

  @Test
  fun surfacesAnErrorRedirect() = runTest {
    val store = InMemoryTokenStore()
    val engine = MockEngine { respond(discovery, HttpStatusCode.OK, jsonHeaders) }
    val session = AuthSession(store, engine = engine)
    session.beginSignIn(session.discover(issuer))
    try {
      session.completeSignIn(Url("gratisgis://auth-callback?error=access_denied&error_description=User%20cancelled"))
      fail("expected SignInException")
    } catch (e: SignInException) {
      assertEquals("User cancelled", e.message)
    }
  }

  @Test
  fun refreshesAnExpiredTokenAndKeepsTheRefreshTokenWhenNotRotated() = runTest {
    val store = InMemoryTokenStore()
    var now = 1_000_000L
    store.save(TokenSet(jwt(), "r1", null, expiresAtMs = now + 10_000, scope = null))
    var refreshForm: Map<String, String>? = null
    val engine = MockEngine { req ->
      when {
        req.url.toString().endsWith("/.well-known/openid-configuration") -> respond(discovery, HttpStatusCode.OK, jsonHeaders)
        req.url.toString().endsWith("/token") -> {
          refreshForm = req.form()
          respond(tokenJson(jwt(sub = "u1"), refresh = null), HttpStatusCode.OK, jsonHeaders)
        }
        else -> fail("unexpected ${req.url}") as Nothing
      }
    }
    val session = AuthSession(store, engine = engine, clock = { now })
    // Fresh enough (10 s left is inside the 30 s skew, so it refreshes).
    val token = session.accessToken()
    assertNotNull(token)
    assertEquals("refresh_token", refreshForm!!["grant_type"])
    assertEquals("r1", refreshForm!!["refresh_token"])
    assertEquals("field-app", refreshForm!!["client_id"])
    assertEquals("r1", store.load()!!.refreshToken)
    assertEquals(now + 300_000, store.load()!!.expiresAtMs)
    // Now fresh: no second exchange.
    refreshForm = null
    now += 60_000
    session.accessToken()
    assertNull(refreshForm)
  }

  @Test
  fun aRevokedOfflineSessionSignsOut() = runTest {
    val store = InMemoryTokenStore()
    store.save(TokenSet(jwt(), "r1", null, expiresAtMs = 0, scope = null))
    val engine = MockEngine { req ->
      if (req.url.toString().endsWith("/.well-known/openid-configuration")) {
        respond(discovery, HttpStatusCode.OK, jsonHeaders)
      } else {
        respond("""{"error":"invalid_grant","error_description":"Session not active"}""", HttpStatusCode.BadRequest, jsonHeaders)
      }
    }
    val session = AuthSession(store, engine = engine, clock = { 5_000_000L })
    assertTrue(session.isSignedIn)
    assertNull(session.accessToken())
    assertFalse(session.isSignedIn)
    assertNull(store.load())
  }

  @Test
  fun aServerFaultDuringRefreshKeepsTheSession() = runTest {
    val store = InMemoryTokenStore()
    store.save(TokenSet(jwt(), "r1", null, expiresAtMs = 0, scope = null))
    val engine = MockEngine { req ->
      if (req.url.toString().endsWith("/.well-known/openid-configuration")) {
        respond(discovery, HttpStatusCode.OK, jsonHeaders)
      } else {
        respond("upstream down", HttpStatusCode.BadGateway)
      }
    }
    val session = AuthSession(store, engine = engine, clock = { 5_000_000L })
    assertNull(session.refreshAccessToken())
    assertTrue(session.isSignedIn)
    assertNotNull(store.load())
  }
}
