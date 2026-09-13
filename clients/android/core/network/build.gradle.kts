// :core:network: the portal-api client. Discovery, the bearer-token
// HTTP client with refresh-on-401, the error taxonomy (copied from
// clients/python), and typed calls for the routes the field client
// uses. See docs/mobile-field-app.md, "What the app talks to".
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "org.gratisgis.field.core.network"
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
  api(libs.kotlinx.coroutines.core)
  api(libs.kotlinx.serialization.json)
  api(libs.ktor.client.core)
  implementation(libs.ktor.client.okhttp)
  implementation(libs.ktor.client.auth)
  implementation(libs.ktor.client.content.negotiation)
  implementation(libs.ktor.serialization.kotlinx.json)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.ktor.client.mock)
}
