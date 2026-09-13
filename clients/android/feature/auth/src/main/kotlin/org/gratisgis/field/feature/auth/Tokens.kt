// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Base64

/** The subset of the OIDC discovery document the flow needs. */
@Serializable
data class OidcConfig(
  val issuer: String,
  @SerialName("authorization_endpoint") val authorizationEndpoint: String,
  @SerialName("token_endpoint") val tokenEndpoint: String,
  @SerialName("end_session_endpoint") val endSessionEndpoint: String? = null,
)

/** Keycloak's token endpoint response. */
@Serializable
internal data class TokenResponse(
  @SerialName("access_token") val accessToken: String,
  @SerialName("refresh_token") val refreshToken: String? = null,
  @SerialName("id_token") val idToken: String? = null,
  @SerialName("expires_in") val expiresIn: Long = 300,
  @SerialName("token_type") val tokenType: String = "Bearer",
  val scope: String? = null,
)

/**
 * What is persisted between launches. `refreshToken` is the offline
 * token; it is the only long-lived secret the app holds and the only
 * reason the store is encrypted.
 */
@Serializable
data class TokenSet(
  val accessToken: String,
  val refreshToken: String?,
  val idToken: String?,
  /** Wall-clock ms when `accessToken` stops being valid. */
  val expiresAtMs: Long,
  val scope: String?,
) {
  fun isFresh(nowMs: Long, skewMs: Long = 30_000): Boolean = nowMs + skewMs < expiresAtMs

  /**
   * Claims from the access token, read without verifying the
   * signature on purpose: the token came from Keycloak over TLS and
   * the server verifies it on every request. See docs/auth-model.md,
   * "Offline Auth".
   */
  fun accessClaims(): JsonObject? = jwtClaims(accessToken)

  val subject: String? get() = accessClaims()?.get("sub")?.jsonPrimitive?.content
  val username: String? get() = accessClaims()?.get("preferred_username")?.jsonPrimitive?.content
  val orgRole: String? get() = accessClaims()?.get("org_role")?.jsonPrimitive?.content

  companion object {
    internal fun from(r: TokenResponse, nowMs: Long): TokenSet = TokenSet(
      accessToken = r.accessToken,
      refreshToken = r.refreshToken,
      idToken = r.idToken,
      expiresAtMs = nowMs + r.expiresIn * 1000,
      scope = r.scope,
    )

    private val json = Json { ignoreUnknownKeys = true }

    internal fun jwtClaims(jwt: String): JsonObject? {
      val parts = jwt.split('.')
      if (parts.size < 2) return null
      return runCatching {
        val payload = Base64.getUrlDecoder().decode(parts[1]).toString(Charsets.UTF_8)
        json.parseToJsonElement(payload).jsonObject
      }.getOrNull()
    }
  }
}
