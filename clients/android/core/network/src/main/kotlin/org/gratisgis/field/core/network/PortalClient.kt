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
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.readAvailable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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

  /** `GET /api/items/{id}/offline-areas`. */
  suspend fun listOfflineAreas(itemId: String): OfflineAreasResponse =
    http.get("items/$itemId/offline-areas").body()

  /**
   * `GET /api/items/{id}/layers/{layerKey}/geojson`, as text. The
   * caller parses it; a layer can be tens of MB and the store keeps
   * the raw feature JSON anyway.
   */
  suspend fun getLayerGeoJson(dataLayerId: String, layerKey: String, bbox: List<Double>? = null): String =
    http.get("items/$dataLayerId/layers/${layerKey.encodeURLPathPart()}/geojson") {
      if (bbox != null) parameter("bbox", bbox.joinToString(","))
    }.bodyAsText()

  /**
   * `GET /api/items/{id}/offline-packages/{packageId}/file`, streamed
   * to `sink`. Returns bytes written. The caller writes to a temp file
   * and renames on success so a partial download never looks complete.
   */
  suspend fun downloadOfflinePackage(
    itemId: String,
    packageId: String,
    sink: java.io.OutputStream,
    onProgress: (received: Long, total: Long?) -> Unit = { _, _ -> },
  ): Long {
    var received = 0L
    http.prepareGet("items/$itemId/offline-packages/$packageId/file").execute { response ->
      val total = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
      val channel = response.bodyAsChannel()
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val n = channel.readAvailable(buffer, 0, buffer.size)
        if (n < 0) break
        if (n == 0) {
          if (channel.isClosedForRead) break
          continue
        }
        sink.write(buffer, 0, n)
        received += n
        onProgress(received, total)
      }
    }
    sink.flush()
    return received
  }

  /** `POST /api/items/{id}/layers/{key}/features`. Throws PortalError on refusal. */
  suspend fun insertFeatures(dataLayerId: String, layerKey: String, body: InsertFeaturesRequest): InsertFeaturesResponse =
    http.post("items/$dataLayerId/layers/${layerKey.encodeURLPathPart()}/features") {
      contentType(ContentType.Application.Json)
      setBody(body)
    }.body()

  /** `PATCH .../features/{globalId}`. Geometry omitted when null: an
   *  attribute-only edit must not erase the position. */
  suspend fun patchFeature(
    dataLayerId: String,
    layerKey: String,
    globalId: String,
    properties: JsonObject,
    geometry: kotlinx.serialization.json.JsonElement?,
  ) {
    val body = buildJsonObject {
      put("properties", properties)
      if (geometry != null && geometry !is kotlinx.serialization.json.JsonNull) put("geometry", geometry)
    }
    http.patch("items/$dataLayerId/layers/${layerKey.encodeURLPathPart()}/features/$globalId") {
      contentType(ContentType.Application.Json)
      setBody(body)
    }
  }

  /** `DELETE .../features/{globalId}`. */
  suspend fun deleteFeature(dataLayerId: String, layerKey: String, globalId: String) {
    http.delete("items/$dataLayerId/layers/${layerKey.encodeURLPathPart()}/features/$globalId")
  }

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
