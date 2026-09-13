// :core:database: Room. The stores mirror the web runtime's IndexedDB
// layout in apps/portal-web/src/lib/offline-store.ts (deployments,
// features, forms, pickLists, queue, blobs, meta); the field names on
// the queue table are contract with the drain and with the engine
// bundle, which takes QueueRecord JSON as input.
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.ksp)
  alias(libs.plugins.androidx.room)
}

android {
  namespace = "org.gratisgis.field.core.database"
  compileSdk = 36
  defaultConfig {
    minSdk = 28
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(17)
}

room {
  // Exported schemas are the migration history; commit them.
  schemaDirectory("$projectDir/schemas")
}

dependencies {
  api(libs.androidx.room.runtime)
  ksp(libs.androidx.room.compiler)
  api(libs.kotlinx.coroutines.core)
  api(libs.kotlinx.serialization.json)

  testImplementation(libs.junit)
}
