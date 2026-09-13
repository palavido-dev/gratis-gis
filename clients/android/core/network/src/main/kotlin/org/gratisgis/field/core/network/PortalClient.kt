// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.auth.Auth
import io.ktor.client.plugins.auth.providers.BearerTokens
import io.ktor.client.plugins.auth.providers.bearer
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * The portal-api client. One instance per signed-in portal.
 *
 * Routes here are portal-api's own (`/api/...`), reached directly:
 * the web client goes through a BFF that this app does not have, so
 * anything the web runtime seems to get for free (anonymous rewrites,
 * revalidation, long-timeout agents) is not here either. See
 * docs/mobile-field-app.md, "What the app talks to".
 */
class PortalClient(
  /** `PortalInfo.api.baseUrl`, ending in `/api`, no trailing slash. */
  val apiBaseUrl: String,
  private val tokens: TokenProvider,
  engine: HttpClientEngine = OkHttp.create(),
) : AutoCloseable {

  val json: Json = defaultJson

  val http: HttpClient = HttpClient(engine) {
    expectSuccess = false
    defaultRequest {
      url(apiBaseUrl.trimEnd('/') + "/")
    }
    install(ContentNegotiation) { json(json) }
    install(HttpTimeout) {
      connectTimeoutMillis = 15_000
      requestTimeoutMillis = 60_000
      socketTimeoutMillis = 60_000
    }
    install(Auth) {
      bearer {
        loadTokens { tokens.accessToken()?.let { BearerTokens(it, "") } }
        refreshTokens { tokens.refreshAccessToken()?.let { BearerTokens(it, "") } }
        // Presigned PUTs to the storage host must not carry the
        // header (it invalidates the signature); only the api host
        // gets it.
        sendWithoutRequest { request -> request.url.toString().startsWith(apiBaseUrl) }
      }
    }
    HttpResponseValidator {
      validateResponse { response ->
        if (response.status.value >= 400) {
          val text = runCatching { response.bodyAsText() }.getOrDefault("")
          throw PortalError.forStatus(
            status = response.status.value,
            message = errorMessage(response.status, text),
            retryAfter = response.headers[HttpHeaders.RetryAfter],
          )
        }
      }
    }
  }

  /** `GET /api/items?type=data_collection&full=1`. */
  suspend fun listCollections(limit: Int = 200): List<ItemSummary> =
    http.get("items") {
      parameter("type", "data_collection")
      parameter("full", "1")
      parameter("limit", limit)
    }.body()

  /** `GET /api/items/{id}`. */
  suspend fun getItem(id: String): ItemSummary = http.get("items/$id").body()

  override fun close() {
    http.close()
  }

  companion object {
    val defaultJson: Json = Json {
      ignoreUnknownKeys = true
      explicitNulls = false
    }

    /** Nest error bodies are `{ statusCode, message, error }`; keep the
     *  message when it parses, fall back to the status text. */
    internal fun errorMessage(status: HttpStatusCode, body: String): String {
      val parsed = runCatching {
        defaultJson.parseToJsonElement(body)
      }.getOrNull()
      val message = (parsed as? kotlinx.serialization.json.JsonObject)?.get("message")
      val text = when (message) {
        is kotlinx.serialization.json.JsonPrimitive -> message.content
        is kotlinx.serialization.json.JsonArray -> message.joinToString("; ") {
          (it as? kotlinx.serialization.json.JsonPrimitive)?.content ?: it.toString()
        }
        else -> null
      }
      return text?.takeIf { it.isNotBlank() } ?: "${status.value} ${status.description}"
    }

    /** `GET {portalUrl}/api/portal-info`, unauthenticated. The one
     *  call made before there is a session. */
    suspend fun discover(portalUrl: String, engine: HttpClientEngine = OkHttp.create()): PortalInfo {
      val base = portalUrl.trim().trimEnd('/')
      HttpClient(engine) {
        install(ContentNegotiation) { json(defaultJson) }
        install(HttpTimeout) { requestTimeoutMillis = 15_000 }
        expectSuccess = false
        HttpResponseValidator {
          validateResponse { response ->
            if (response.status.value >= 400) {
              throw PortalError.forStatus(
                response.status.value,
                errorMessage(response.status, runCatching { response.bodyAsText() }.getOrDefault("")),
                response.headers[HttpHeaders.RetryAfter],
              )
            }
          }
        }
      }.use { client ->
        return client.get("$base/api/portal-info").body()
      }
    }
  }
}
