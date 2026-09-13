// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.network

/**
 * What the HTTP client needs from whoever owns the session. Kept as
 * an interface so :core:network does not depend on :feature:auth and
 * tests can supply a fixed token.
 */
interface TokenProvider {
  /** The current access token, or null when signed out. */
  suspend fun accessToken(): String?

  /** Obtain a fresh access token after a 401. Null means the session
   *  is gone and the caller should treat the user as signed out. */
  suspend fun refreshAccessToken(): String?
}

object NoTokens : TokenProvider {
  override suspend fun accessToken(): String? = null
  override suspend fun refreshAccessToken(): String? = null
}
