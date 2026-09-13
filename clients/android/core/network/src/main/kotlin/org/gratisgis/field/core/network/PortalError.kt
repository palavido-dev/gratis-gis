// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

/**
 * Error taxonomy, copied from clients/python/src/gratisgis/client.py
 * so the two native clients speak the same way about failures. The
 * queue's retry-or-park decision is NOT made here; that is
 * `sync.outcome` in the engine bundle, which takes the raw status.
 */
sealed class PortalError(
  val status: Int,
  message: String,
) : Exception(message) {

  /** 401 or 403. */
  class Auth(status: Int, message: String) : PortalError(status, message)

  /** 404. */
  class NotFound(message: String) : PortalError(404, message)

  /** 400 or 422: the server refused the bytes deterministically. */
  class Validation(status: Int, message: String) : PortalError(status, message)

  /** 409. */
  class Conflict(message: String) : PortalError(409, message)

  /** 429, or 503 with Retry-After. `retryAfterSeconds` is null when the
   *  server sent none. */
  class RateLimit(status: Int, message: String, val retryAfterSeconds: Long?) :
    PortalError(status, message)

  /** Anything else with a status. */
  class Server(status: Int, message: String) : PortalError(status, message)

  companion object {
    fun forStatus(status: Int, message: String, retryAfter: String?): PortalError = when (status) {
      401, 403 -> Auth(status, message)
      404 -> NotFound(message)
      400, 422 -> Validation(status, message)
      409 -> Conflict(message)
      429 -> RateLimit(status, message, retryAfter?.trim()?.toLongOrNull())
      503 -> if (retryAfter != null) RateLimit(status, message, retryAfter.trim().toLongOrNull())
      else Server(status, message)
      else -> Server(status, message)
    }
  }
}
