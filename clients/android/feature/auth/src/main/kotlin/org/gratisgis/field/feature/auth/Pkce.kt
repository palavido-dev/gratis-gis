// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** RFC 7636. Pure; no Android in it so it is unit tested on the JVM. */
object Pkce {
  private val random = SecureRandom()

  /** 32 random bytes, base64url without padding: 43 characters, all
   *  in the unreserved set the RFC requires. */
  fun newVerifier(): String = base64Url(ByteArray(32).also(random::nextBytes))

  /** `S256`: base64url(sha256(ascii(verifier))). */
  fun challenge(verifier: String): String =
    base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

  /** Opaque state to bind the redirect to the request that opened it. */
  fun newState(): String = base64Url(ByteArray(16).also(random::nextBytes))

  private fun base64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
