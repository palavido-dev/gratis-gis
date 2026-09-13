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

/** `GET /api/items/{id}/offline-areas`. Mirrors OfflineAreaWithPackage. */
@Serializable
data class OfflineAreasResponse(
  val areas: List<OfflineAreaWithPackage>,
  val maxTiles: Int,
)

@Serializable
data class OfflineAreaWithPackage(
  val area: OfflineArea,
  val current: OfflinePackageSummary? = null,
  val pending: OfflinePackageSummary? = null,
  val lastFailure: OfflinePackageSummary? = null,
)

@Serializable
data class OfflineArea(
  val id: String,
  val name: String,
  /** west, south, east, north. */
  val bbox: List<Double>,
  val minZoom: Int,
  val maxZoom: Int,
  val refreshDays: Int? = null,
)

@Serializable
data class OfflinePackageSummary(
  val id: String,
  val areaId: String,
  val status: String,
  val bbox: List<Double>,
  val minZoom: Int,
  val maxZoom: Int,
  val tileCount: Long? = null,
  val sizeBytes: Long? = null,
  val error: String? = null,
  val createdAt: String,
  val startedAt: String? = null,
  val finishedAt: String? = null,
)

/** Request body of `POST .../features`. `globalId` is the client's. */
@Serializable
data class FeatureInsert(
  val globalId: String,
  val geometry: kotlinx.serialization.json.JsonElement?,
  val properties: JsonObject,
)

@Serializable
data class InsertFeaturesRequest(val features: List<FeatureInsert>)

/** Response of `POST .../features`: `globalIds` is order-aligned to the request. */
@Serializable
data class InsertFeaturesResponse(
  val inserted: Int = 0,
  val deduplicated: Int = 0,
  val globalIds: List<String> = emptyList(),
)

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
