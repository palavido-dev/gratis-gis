// :feature:sync: take a collection offline and bring edits back.
// Orchestration only. Which rows to replay, whether a row is
// claimable, how edits fold, and what an HTTP status means for a
// queued edit are all answered by the engine bundle (queue.*,
// sync.outcome); this module asks and acts.
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "org.gratisgis.field.feature.sync"
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

dependencies {
  api(project(":core:engine"))
  api(project(":core:network"))
  api(project(":core:database"))
  implementation(libs.kotlinx.coroutines.android)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
