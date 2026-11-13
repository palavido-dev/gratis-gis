// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeoutCapability
import io.ktor.client.plugins.HttpTimeoutConfig
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

  @Test
  fun getLayerDeltaPassesSinceAndLimit() = runTest {
    val engine = MockEngine { request ->
      assertEquals(
        "https://portal.example/api/items/dl1/layers/main/delta?since=42&limit=10000",
        request.url.toString(),
      )
      respond(
        """{"syncVersion":50,"since":42,"truncated":false,"changes":[{"observationId":"o1","entity":"e1","kind":"update","syncVersion":43,"geometry":null,"properties":{"n":1}}]}""",
        HttpStatusCode.OK,
        jsonHeaders,
      )
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      val body = client.getLayerDelta("dl1", "main", since = 42, limit = 10_000)
      assertEquals(50L, body.syncVersion)
      assertEquals(42L, body.since)
      assertEquals(1, body.changes.size)
      assertEquals("e1", body.changes[0].entity)
      assertEquals("update", body.changes[0].kind)
    }
  }

  @Test
  fun getLayerDeltaPassesAfterAndReadsNextCursor() = runTest {
    val engine = MockEngine { request ->
      assertEquals(
        "https://portal.example/api/items/dl1/layers/main/delta?since=43&after=o1&limit=10000",
        request.url.toString(),
      )
      respond(
        """{"syncVersion":50,"since":43,"truncated":true,"nextSince":43,"nextAfter":"o2","changes":[{"observationId":"o2","entity":"e2","kind":"create","syncVersion":43,"createdBy":"u1","createdAt":"2026-11-08T00:00:00.000Z","geometry":null,"properties":{}}]}""",
        HttpStatusCode.OK,
        jsonHeaders,
      )
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      val body = client.getLayerDelta("dl1", "main", since = 43, limit = 10_000, after = "o1")
      assertEquals(43L, body.nextSince)
      assertEquals("o2", body.nextAfter)
      assertEquals("u1", body.changes[0].createdBy)
    }
  }

  @Test
  fun getLayerGeoJsonPagesWithLimitCursorAndAt() = runTest {
    val engine = MockEngine { request ->
      assertEquals("5000", request.url.parameters["limit"])
      assertEquals("c1", request.url.parameters["cursor"])
      assertEquals("2026-11-08T00:00:00.000Z", request.url.parameters["at"])
      respond("""{"type":"FeatureCollection","features":[],"nextCursor":null}""", HttpStatusCode.OK, jsonHeaders)
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      client.getLayerGeoJson("dl1", "main", limit = 5_000, cursor = "c1", at = "2026-11-08T00:00:00.000Z")
    }
  }

  @Test
  fun patchFeatureReturnsTheWrittenFeature() = runTest {
    val engine = MockEngine {
      respond(
        """{"type":"Feature","id":"g1","properties":{"name":"x","_observation_id":"obs-2"}}""",
        HttpStatusCode.OK,
        jsonHeaders,
      )
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      val written = client.patchFeature("dl1", "main", "g1", kotlinx.serialization.json.JsonObject(emptyMap()), null)
      assertEquals(
        "obs-2",
        (written?.get("properties") as? kotlinx.serialization.json.JsonObject)
          ?.get("_observation_id")?.toString()?.trim('"'),
      )
    }
  }

  @Test
  fun patchFeatureWithoutAJsonBodyReturnsNull() = runTest {
    val engine = MockEngine { respond("", HttpStatusCode.NoContent) }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      assertNull(client.patchFeature("dl1", "main", "g1", kotlinx.serialization.json.JsonObject(emptyMap()), null))
    }
  }

  @Test
  fun packageDownloadHasNoOverallRequestTimeout() = runTest {
    var requestTimeout: Long? = null
    var socketTimeout: Long? = null
    val engine = MockEngine { request ->
      val config = request.getCapabilityOrNull(HttpTimeoutCapability)
      requestTimeout = config?.requestTimeoutMillis
      socketTimeout = config?.socketTimeoutMillis
      respond(ByteArray(10) { it.toByte() }, HttpStatusCode.OK)
    }
    PortalClient("https://portal.example/api", FakeTokens("tok"), engine).use { client ->
      val out = java.io.ByteArrayOutputStream()
      assertEquals(10L, client.downloadOfflinePackage("c1", "p1", out))
      // A large package must not be cut off by the client-wide 60 s
      // limit; the socket timeout still catches a stalled transfer.
      assertEquals(HttpTimeoutConfig.INFINITE_TIMEOUT_MS, requestTimeout)
      assertEquals(60_000L, socketTimeout)
    }
  }
}
