// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Persistence for the session. An interface so the JVM tests use a map. */
interface TokenStore {
  fun load(): TokenSet?
  fun save(tokens: TokenSet)
  fun clear()

  /** The PKCE verifier and state of a sign-in that has opened the
   *  browser and not yet come back. Short-lived, but it must survive
   *  the process being killed behind the Custom Tab. */
  fun loadPending(): PendingSignIn?
  fun savePending(pending: PendingSignIn?)
}

data class PendingSignIn(val verifier: String, val state: String, val issuer: String)

class InMemoryTokenStore : TokenStore {
  private var tokens: TokenSet? = null
  private var pending: PendingSignIn? = null
  override fun load(): TokenSet? = tokens
  override fun save(tokens: TokenSet) { this.tokens = tokens }
  override fun clear() { tokens = null }
  override fun loadPending(): PendingSignIn? = pending
  override fun savePending(pending: PendingSignIn?) { this.pending = pending }
}

/**
 * Tokens as AES-GCM ciphertext in SharedPreferences, under a key that
 * lives in the Android Keystore and never leaves it. This is what the
 * deprecated androidx.security EncryptedSharedPreferences did, minus
 * the library: one key, one cipher, no key-derivation scheme to
 * migrate later.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
  private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val json = Json { ignoreUnknownKeys = true }

  override fun load(): TokenSet? =
    prefs.getString(KEY_TOKENS, null)?.let { blob ->
      runCatching { json.decodeFromString(TokenSet.serializer(), decrypt(blob)) }.getOrNull()
    }

  override fun save(tokens: TokenSet) {
    prefs.edit().putString(KEY_TOKENS, encrypt(json.encodeToString(TokenSet.serializer(), tokens))).apply()
  }

  override fun clear() {
    prefs.edit().remove(KEY_TOKENS).apply()
  }

  override fun loadPending(): PendingSignIn? {
    val v = prefs.getString(KEY_PENDING_VERIFIER, null) ?: return null
    val s = prefs.getString(KEY_PENDING_STATE, null) ?: return null
    val i = prefs.getString(KEY_PENDING_ISSUER, null) ?: return null
    return PendingSignIn(decrypt(v), s, i)
  }

  override fun savePending(pending: PendingSignIn?) {
    val e = prefs.edit()
    if (pending == null) {
      e.remove(KEY_PENDING_VERIFIER).remove(KEY_PENDING_STATE).remove(KEY_PENDING_ISSUER)
    } else {
      e.putString(KEY_PENDING_VERIFIER, encrypt(pending.verifier))
        .putString(KEY_PENDING_STATE, pending.state)
        .putString(KEY_PENDING_ISSUER, pending.issuer)
    }
    e.apply()
  }

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  private fun encrypt(plain: String): String {
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
  }

  private fun decrypt(blob: String): String {
    val (ivB64, ctB64) = blob.split(':', limit = 2)
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(ivB64, Base64.NO_WRAP)))
    return cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP)).toString(Charsets.UTF_8)
  }

  private companion object {
    const val PREFS = "gratisgis.field.auth"
    const val KEY_TOKENS = "tokens"
    const val KEY_PENDING_VERIFIER = "pending.verifier"
    const val KEY_PENDING_STATE = "pending.state"
    const val KEY_PENDING_ISSUER = "pending.issuer"
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "gratisgis.field.tokens"
    const val TRANSFORM = "AES/GCM/NoPadding"
  }
}
