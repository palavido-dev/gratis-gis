// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.gratisgis.field.core.database.QueueEntity
import org.gratisgis.field.core.engine.CallResult
import org.gratisgis.field.core.engine.FieldEngine
import java.security.MessageDigest

/** Thrown when the engine answers with an error envelope; a bug, not a
 *  condition to handle, because every argument here is built by us. */
class EngineCallException(val name: String, val code: String, override val message: String) :
  IllegalStateException("$name: $code: $message")

internal suspend fun FieldEngine.callOrThrow(name: String, args: JsonObject): JsonElement =
  when (val r = call(name, args)) {
    is CallResult.Ok -> r.result
    is CallResult.Error -> throw EngineCallException(name, r.code, r.message)
  }

/** The `QueueRecord` JSON the engine's `queue.*` functions read. */
internal fun QueueEntity.toEngineRow(json: kotlinx.serialization.json.Json): JsonObject = buildJsonObject {
  put("id", JsonPrimitive(id))
  put("dataCollectionId", JsonPrimitive(collectionId))
  put("op", JsonPrimitive(op))
  put("dataLayerId", JsonPrimitive(dataLayerId))
  put("layerKey", JsonPrimitive(layerKey))
  put("globalId", JsonPrimitive(globalId))
  put("geometry", geometryJson?.let { json.parseToJsonElement(it) } ?: JsonNull)
  put("properties", propertiesJson?.let { json.parseToJsonElement(it) } ?: JsonNull)
  put("queuedAt", JsonPrimitive(queuedAt))
  put("schemaHash", JsonPrimitive(schemaHash))
  put("syncStatus", JsonPrimitive(syncStatus))
  failureJson?.let { put("failure", json.parseToJsonElement(it)) }
  lastAttemptAt?.let { put("lastAttemptAt", JsonPrimitive(it)) }
  retryCount?.let { put("retryCount", JsonPrimitive(it)) }
  ownerUserId?.let { put("ownerUserId", JsonPrimitive(it)) }
}

/** `feature.schemaCanonical` hashed the way the web runtime does:
 *  SHA-256, first 16 hex characters. */
internal suspend fun FieldEngine.schemaHash(fieldsJson: JsonElement): String {
  val text = callOrThrow("feature.schemaCanonical", buildJsonObject { put("fields", fieldsJson) }).jsonPrimitive.content
  val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
  return digest.take(8).joinToString("") { "%02x".format(it) }
}
