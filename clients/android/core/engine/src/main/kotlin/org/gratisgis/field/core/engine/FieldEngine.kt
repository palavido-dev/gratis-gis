// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.engine

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.evaluate
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest

/**
 * The host for the field engine bundle (`packages/field-engine`).
 *
 * One QuickJS runtime, one context, every call serialised through a
 * mutex so the engine only ever runs one thing at a time. The bundle
 * exposes a single string-in string-out entry point, `call`, and this
 * class is a thin marshalling layer over it: it never decides anything
 * about a record, a form, or a queued edit. If a decision is needed,
 * add a function to the bundle.
 *
 * Construction verifies the bundle's SHA-256 against the value the
 * build recorded from the manifest (see build.gradle.kts), so an APK
 * can never run an engine other than the one it was built with.
 */
class FieldEngine private constructor(
  private val js: QuickJs,
  val info: EngineInfo,
) : AutoCloseable {

  private val lock = Mutex()

  /**
   * Call a surface function by wire name with its single argument
   * object as JSON text. Returns the parsed envelope; never throws for
   * an engine-side error, only for a host-side failure (engine closed,
   * evaluation interrupted).
   */
  suspend fun call(name: String, argsJson: String): CallResult {
    val script = "GratisFieldEngine.call(${jsLiteral(name)}, ${jsLiteral(argsJson)})"
    val raw = lock.withLock { js.evaluate<String>(script, filename = "call:$name") }
    return parseResult(raw)
  }

  /** Convenience for callers holding a JSON object rather than text. */
  suspend fun call(name: String, args: JsonObject): CallResult = call(name, args.toString())

  override fun close() {
    js.close()
  }

  companion object {
    /**
     * Load the engine from bundle source. `expectedSha256` is the hash
     * the build recorded; pass null only in tests that construct a
     * bundle by hand.
     */
    suspend fun fromSource(
      source: String,
      expectedSha256: String?,
      dispatcher: CoroutineDispatcher = Dispatchers.Default,
      evaluationTimeoutMillis: Long = DEFAULT_EVALUATION_TIMEOUT_MS,
    ): FieldEngine {
      val actual = sha256Hex(source.toByteArray(Charsets.UTF_8))
      if (expectedSha256 != null && !actual.equals(expectedSha256, ignoreCase = true)) {
        throw EngineIntegrityException(expected = expectedSha256, actual = actual)
      }
      val js = QuickJs.create(dispatcher)
      try {
        js.evaluationTimeoutMillis = evaluationTimeoutMillis
        js.evaluate<Any?>(source, filename = BUNDLE_FILE_NAME)
        val infoJson = js.evaluate<String>("GratisFieldEngine.call('engine.info', '{}')")
        val info = when (val r = parseResult(infoJson)) {
          is CallResult.Ok -> EngineInfo.fromJson(r.result.jsonObject, actual)
          is CallResult.Error -> throw EngineLoadException("engine.info failed: ${r.code}: ${r.message}")
        }
        return FieldEngine(js, info)
      } catch (t: Throwable) {
        js.close()
        throw t
      }
    }

    const val BUNDLE_FILE_NAME = "gratis-field-engine.js"
    const val MANIFEST_FILE_NAME = "engine-version.json"

    /** A form evaluation that takes longer than this is a bug, not a
     *  slow phone; the timeout turns it into an exception instead of a
     *  hung UI. */
    const val DEFAULT_EVALUATION_TIMEOUT_MS = 5_000L

    private val json = Json { ignoreUnknownKeys = true }

    internal fun parseResult(raw: String): CallResult {
      val obj = json.parseToJsonElement(raw).jsonObject
      val ok = obj["ok"]?.jsonPrimitive?.boolean ?: false
      return if (ok) {
        CallResult.Ok(obj["result"] ?: JsonNull)
      } else {
        val err = obj["error"]?.jsonObject
        CallResult.Error(
          code = err?.get("code")?.jsonPrimitive?.content ?: "unknown",
          message = err?.get("message")?.jsonPrimitive?.content ?: raw,
        )
      }
    }

    /** A JSON string literal is a valid JavaScript string literal, so
     *  this is the whole escaping story. */
    internal fun jsLiteral(s: String): String = JsonPrimitive(s).toString()

    internal fun sha256Hex(bytes: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  }
}

/** The envelope every surface call returns. Mirrors `CallResult` in
 *  packages/field-engine/src/index.ts. */
sealed interface CallResult {
  data class Ok(val result: JsonElement) : CallResult
  data class Error(val code: String, val message: String) : CallResult
}

/** What `engine.info` reports, plus the hash of the loaded source. */
data class EngineInfo(
  val engineVersion: Int,
  val queueClaimStaleMs: Long,
  val functions: List<String>,
  val sha256: String,
) {
  companion object {
    internal fun fromJson(obj: JsonObject, sha256: String): EngineInfo = EngineInfo(
      engineVersion = obj.getValue("engineVersion").jsonPrimitive.int,
      queueClaimStaleMs = obj.getValue("queueClaimStaleMs").jsonPrimitive.content.toLong(),
      functions = obj.getValue("functions").jsonArray.map { it.jsonPrimitive.content },
      sha256 = sha256,
    )
  }
}

class EngineIntegrityException(val expected: String, val actual: String) :
  IllegalStateException("Field engine bundle hash mismatch: expected $expected, got $actual")

class EngineLoadException(message: String) : IllegalStateException(message)
