// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Wire shapes for the routes the field client uses. These mirror the
 * TypeScript in packages/shared-types by hand; keep them narrow (only
 * the fields the app reads, unknown keys ignored) so a server that
 * adds a field never breaks an installed app.
 */

/** `GET /api/portal-info`. Mirrors `PortalInfo` in shared-types. */
@Serializable
data class PortalInfo(
  val name: String,
  val version: String,
  val api: Api,
  val auth: Auth,
) {
  @Serializable
  data class Api(val baseUrl: String)

  @Serializable
  data class Auth(val type: String, val issuer: String)
}

/** One row of `GET /api/items`. `data` is present only with `full=1`. */
@Serializable
data class ItemSummary(
  val id: String,
  val title: String,
  val type: String,
  val description: String? = null,
  val updatedAt: String? = null,
  val ownerId: String? = null,
  val data: JsonObject? = null,
)
