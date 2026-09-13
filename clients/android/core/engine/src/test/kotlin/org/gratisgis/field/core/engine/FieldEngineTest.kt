// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.core.engine

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Runs the real bundle from packages/field-engine/dist inside
 * quickjs-kt on the desktop JVM. This is the host-integration half of
 * the conformance gate in docs/mobile-field-app.md: the TypeScript
 * spec proves the bundle answers in a bare vm context; this proves the
 * Kotlin marshalling round-trips through QuickJS.
 */
class FieldEngineTest {

  private val bundlePath = System.getProperty("gratisgis.fieldEngine.bundle")
    ?: error("gratisgis.fieldEngine.bundle not set; run through Gradle")
  private val expectedSha = System.getProperty("gratisgis.fieldEngine.sha256")!!
  private val expectedVersion = System.getProperty("gratisgis.fieldEngine.version")!!.toInt()

  private fun source(): String = File(bundlePath).readText(Charsets.UTF_8)

  private suspend fun load(): FieldEngine = FieldEngine.fromSource(source(), expectedSha)

  @Test
  fun loadsAndReportsTheVersionTheBuildRecorded() = runTest {
    load().use { engine ->
      assertEquals(expectedVersion, engine.info.engineVersion)
      assertEquals(expectedSha, engine.info.sha256)
      assertEquals(120_000L, engine.info.queueClaimStaleMs)
      assertTrue("engine.info" in engine.info.functions)
      assertTrue("form.validate" in engine.info.functions)
    }
  }

  @Test
  fun refusesATamperedBundle() = runTest {
    try {
      FieldEngine.fromSource(source() + "\n// tampered", expectedSha)
      fail("expected EngineIntegrityException")
    } catch (e: EngineIntegrityException) {
      assertEquals(expectedSha, e.expected)
    }
  }

  @Test
  fun validatesAFormTheSameWayTheServerDoes() = runTest {
    load().use { engine ->
      val args = buildJsonObject {
        putJsonObject("form") {
          put("schemaVersion", 1)
          put("id", "f")
          put("title", "T")
          putJsonArray("questions") {
            add(buildJsonObject {
              put("id", "count")
              put("type", "integer")
              put("label", "Count")
              put("required", true)
              putJsonObject("constraint") {
                put("op", "gte")
                putJsonObject("left") { put("ref", "count") }
                putJsonObject("right") { put("value", 0) }
              }
            })
          }
        }
        putJsonObject("response") { put("count", -1) }
      }
      when (val r = engine.call("form.validate", args)) {
        is CallResult.Ok -> {
          val result = r.result.jsonObject
          assertEquals(false, result.getValue("ok").jsonPrimitive.content.toBoolean())
          val errors = result.getValue("errors").jsonArray
          assertEquals(1, errors.size)
          assertEquals("count", errors[0].jsonObject.getValue("questionId").jsonPrimitive.content)
        }
        is CallResult.Error -> fail("unexpected error ${r.code}: ${r.message}")
      }
    }
  }

  @Test
  fun reportsEngineSideErrorsAsData() = runTest {
    load().use { engine ->
      val r = engine.call("nope", "{}")
      assertTrue(r is CallResult.Error)
      assertEquals("unknown-function", (r as CallResult.Error).code)

      val bad = engine.call("form.validate", "{not json")
      assertEquals("bad-argument", (bad as CallResult.Error).code)
    }
  }

  @Test
  fun escapesArgumentsThatWouldBreakAScriptLiteral() = runTest {
    load().use { engine ->
      // Quotes, backslashes, newlines and a script-closing sequence all
      // travel as data. `message.sanitize` echoes a legacy string back.
      val nasty = "a\"b\\c\nd</script>'e f"
      val r = engine.call("message.sanitize", buildJsonObject { put("message", nasty) })
      val env = (r as CallResult.Ok).result.jsonObject
      assertEquals("legacy.text", env.getValue("code").jsonPrimitive.content)
      assertEquals(nasty, env.getValue("params").jsonObject.getValue("text").jsonPrimitive.content)
    }
  }

  @Test
  fun queueDecisionsTakeTheClockFromTheHost() = runTest {
    load().use { engine ->
      val row = buildJsonObject {
        put("dataLayerId", "dl")
        put("layerKey", "pts")
        put("globalId", "g1")
        put("queuedAt", "2026-09-13T10:00:00.000Z")
        put("syncStatus", "failed")
        put("lastAttemptAt", "2026-09-13T10:00:10.000Z")
        put("retryCount", 2)
      }
      val tooSoon = engine.call("queue.isClaimable", buildJsonObject {
        put("row", row)
        put("nowMs", 1_789_293_620_000L) // 10:00:20Z, inside the 15 s ladder step
      })
      assertEquals("false", (tooSoon as CallResult.Ok).result.jsonPrimitive.content)
      val later = engine.call("queue.isClaimable", buildJsonObject {
        put("row", row)
        put("nowMs", 1_789_293_700_000L) // 10:01:40Z
      })
      assertEquals("true", (later as CallResult.Ok).result.jsonPrimitive.content)
    }
  }

  @Test
  fun serialisesConcurrentCallers() = runTest {
    load().use { engine ->
      val results = (1..50).map { i ->
        async {
          engine.call("queue.retryDelayMs", buildJsonObject { put("retryCount", i % 6) })
        }
      }.map { it.await() }
      results.forEach { assertTrue(it is CallResult.Ok) }
      assertEquals("0", (results[5] as CallResult.Ok).result.jsonPrimitive.content)   // retryCount 0 -> 0 ms
      assertEquals("5000", (results[0] as CallResult.Ok).result.jsonPrimitive.content) // retryCount 1 -> 5 s
    }
  }

  @Test
  fun parsesResultEnvelopesWithoutAnEngine() {
    val ok = FieldEngine.parseResult("""{"ok":true,"result":{"a":1}}""")
    assertTrue(ok is CallResult.Ok)
    val err = FieldEngine.parseResult("""{"ok":false,"error":{"code":"threw","message":"boom"}}""")
    assertEquals(CallResult.Error("threw", "boom"), err)
    assertEquals("\"a\\\"b\"", FieldEngine.jsLiteral("a\"b"))
    assertEquals(Json.parseToJsonElement("\"x\"").jsonPrimitive.content, "x")
  }
}
