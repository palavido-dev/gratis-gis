// :core:engine hosts the field engine bundle (packages/field-engine) in
// an embedded QuickJS and exposes its one entry point to Kotlin. The
// bundle is a build artifact of the pnpm workspace, copied in as an
// asset here; nothing in this module decides anything about a record.
import groovy.json.JsonSlurper

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
}

// The pnpm build writes the bundle and its manifest here. The Android
// build never builds it itself: two toolchains producing the same file
// is how the two drift.
val fieldEngineDist = rootProject.layout.projectDirectory.dir("../../packages/field-engine/dist")
val fieldEngineBundle = fieldEngineDist.file("gratis-field-engine.js")
val fieldEngineManifest = fieldEngineDist.file("engine-version.json")

fun readManifest(): Map<String, Any?> {
  val file = fieldEngineManifest.asFile
  check(file.isFile) {
    "Field engine manifest not found at ${file.absolutePath}. " +
      "Run `pnpm -C packages/field-engine build` in the repo root first."
  }
  @Suppress("UNCHECKED_CAST")
  return JsonSlurper().parse(file) as Map<String, Any?>
}

val manifest = readManifest()
val manifestSha256 = manifest["sha256"] as String
val manifestVersion = (manifest["engineVersion"] as Number).toInt()

android {
  namespace = "org.gratisgis.field.core.engine"
  compileSdk = 36
  defaultConfig {
    minSdk = 28
    // The hash the manifest recorded at bundle build time. The runtime
    // hashes the asset it actually loaded and refuses to start on a
    // mismatch, so an APK can never run an engine other than the one
    // its build recorded.
    buildConfigField("String", "FIELD_ENGINE_SHA256", "\"$manifestSha256\"")
    buildConfigField("int", "FIELD_ENGINE_VERSION", "$manifestVersion")
  }
  buildFeatures {
    buildConfig = true
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(17)
}

// Copy the bundle into a generated asset directory rather than
// referencing the pnpm output directly, so the APK's inputs are all
// under build/ and the copy is a tracked, cacheable task. AGP wires
// `outputDir` to a variant-specific directory itself.
abstract class CopyFieldEngineBundle : DefaultTask() {
  @get:InputFile abstract val bundle: RegularFileProperty
  @get:InputFile abstract val manifest: RegularFileProperty
  @get:OutputDirectory abstract val outputDir: DirectoryProperty

  @TaskAction
  fun run() {
    val src = bundle.get().asFile
    check(src.isFile) {
      "Field engine bundle not found at ${src.absolutePath}. " +
        "Run `pnpm -C packages/field-engine build` in the repo root first."
    }
    val out = outputDir.get().asFile
    out.mkdirs()
    src.copyTo(out.resolve("gratis-field-engine.js"), overwrite = true)
    manifest.get().asFile.copyTo(out.resolve("engine-version.json"), overwrite = true)
  }
}

// No closures here: the task must not capture script state or the
// configuration cache refuses to serialise it.
val copyFieldEngineBundle by tasks.registering(CopyFieldEngineBundle::class) {
  bundle.set(fieldEngineBundle)
  manifest.set(fieldEngineManifest)
}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(
      copyFieldEngineBundle,
      CopyFieldEngineBundle::outputDir,
    )
  }
}

// Local unit tests run on the desktop JVM, which cannot load the
// Android native library; substitute the -jvm artifact there, per the
// quickjs-kt README. Instrumented tests on a device need no swap.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
  resolutionStrategy.dependencySubstitution {
    substitute(module("io.github.dokar3:quickjs-kt-android"))
      .using(module("io.github.dokar3:quickjs-kt-jvm:${libs.versions.quickjsKt.get()}"))
  }
}

tasks.withType<Test>().configureEach {
  // The JVM unit test loads the same bundle the APK ships, straight
  // from the pnpm output, so it tests the real artifact.
  systemProperty("gratisgis.fieldEngine.bundle", fieldEngineBundle.asFile.absolutePath)
  systemProperty("gratisgis.fieldEngine.sha256", manifestSha256)
  systemProperty("gratisgis.fieldEngine.version", manifestVersion)
}

dependencies {
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.quickjs.kt)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
