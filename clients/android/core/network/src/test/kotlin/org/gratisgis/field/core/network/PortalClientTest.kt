// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PortalClientTest {

  private class FakeTokens(var access: String?, var refreshed: String? = null) : TokenProvider {
    var refreshCalls = 0
    override suspend fun accessToken(): String? = access
    override suspend fun refreshAccessToken(): String? {
      refreshCalls += 1
      access = refreshed
      return refreshed
    }
  }

  private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")

  @Test
  fun sendsTheBearerTokenOnTheFirstRequestAndParsesRows() = runTest {
    var seenAuth: String? = null
    val engine = MockEngine { request ->
      seenAuth = request.headers[HttpHeaders.Authorization]
      assertEquals("https://portal.example/api/items?type=data_collection&full=1&limit=200", request.url.toString())
      respond(
        """[{"id":"c1","title":"Trail survey","type":"data_collection","data":{"version":1,"mapId":"m1"},"extra":true}]""",
        HttpStatusCode.OK,
        jsonHeaders,
      )
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      val rows = client.listCollections()
      assertEquals("Bearer tok", seenAuth)
      assertEquals(1, rows.size)
      assertEquals("Trail survey", rows[0].title)
      assertEquals("m1", rows[0].data?.get("mapId")?.toString()?.trim('"'))
      assertNull(rows[0].description)
    }
  }

  @Test
  fun refreshesOnceOn401AndRetries() = runTest {
    var calls = 0
    val engine = MockEngine { request ->
      calls += 1
      if (request.headers[HttpHeaders.Authorization] == "Bearer fresh") {
        respond("""{"id":"x","title":"X","type":"data_collection"}""", HttpStatusCode.OK, jsonHeaders)
      } else {
        respond(
          """{"statusCode":401,"message":"Unauthorized"}""",
          HttpStatusCode.Unauthorized,
          headersOf(
            HttpHeaders.ContentType to listOf("application/json"),
            HttpHeaders.WWWAuthenticate to listOf("Bearer"),
          ),
        )
      }
    }
    val tokens = FakeTokens(access = "stale", refreshed = "fresh")
    PortalClient("https://portal.example/api", tokens, engine).use { client ->
      val item = client.getItem("x")
      assertEquals("X", item.title)
      assertEquals(1, tokens.refreshCalls)
      assertEquals(2, calls)
    }
  }

  @Test
  fun mapsStatusesToTheSharedTaxonomy() = runTest {
    val cases = listOf(
      HttpStatusCode.Forbidden to PortalError.Auth::class,
      HttpStatusCode.NotFound to PortalError.NotFound::class,
      HttpStatusCode.UnprocessableEntity to PortalError.Validation::class,
      HttpStatusCode.Conflict to PortalError.Conflict::class,
      HttpStatusCode.TooManyRequests to PortalError.RateLimit::class,
      HttpStatusCode.InternalServerError to PortalError.Server::class,
    )
    for ((status, expected) in cases) {
      val engine = MockEngine {
        respond(
          """{"statusCode":${status.value},"message":["first problem","second problem"]}""",
          status,
          headersOf(
            HttpHeaders.ContentType to listOf("application/json"),
            HttpHeaders.RetryAfter to listOf("7"),
          ),
        )
      }
      PortalClient("https://portal.example/api", FakeTokens("t"), engine).use { client ->
        try {
          client.getItem("x")
          fail("expected ${expected.simpleName} for ${status.value}")
        } catch (e: PortalError) {
          assertTrue("got ${e::class.simpleName} for ${status.value}", expected.isInstance(e))
          assertEquals(status.value, e.status)
          assertEquals("first problem; second problem", e.message)
          if (e is PortalError.RateLimit) assertEquals(7L, e.retryAfterSeconds)
        }
      }
    }
  }

  @Test
  fun a503WithRetryAfterIsRateLimitingNotAServerFault() {
    val e = PortalError.forStatus(503, "saturated", "30")
    assertTrue(e is PortalError.RateLimit)
    assertEquals(30L, (e as PortalError.RateLimit).retryAfterSeconds)
    assertTrue(PortalError.forStatus(503, "down", null) is PortalError.Server)
  }

  @Test
  fun discoveryReadsPortalInfo() = runTest {
    val engine = MockEngine { request ->
      assertEquals("https://portal.example/api/portal-info", request.url.toString())
      assertNull(request.headers[HttpHeaders.Authorization])
      respond(
        """{"name":"Demo","version":"0.9.113","api":{"baseUrl":"https://portal.example/api"},"auth":{"type":"oidc","issuer":"https://auth.example/realms/gratis-gis"},"features":{"feedback":true}}""",
        HttpStatusCode.OK,
        jsonHeaders,
      )
    }
    val info = PortalClient.discover("https://portal.example/", engine)
    assertEquals("Demo", info.name)
    assertEquals("https://auth.example/realms/gratis-gis", info.auth.issuer)
  }
}
