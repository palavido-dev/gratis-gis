// :feature:auth: sign-in against the portal's Keycloak realm as the
// `field-app` public client. Authorization code + PKCE in a Custom
// Tab, offline_access refresh tokens in Keystore-encrypted storage.
//
// Hand-rolled rather than AppAuth-Android: AppAuth's last release was
// 0.11.1 in December 2021, and the flow is a URL, a form POST and a
// redirect. See docs/mobile-field-app.md, "Mobile auth".
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "org.gratisgis.field.feature.auth"
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
  api(project(":core:network"))
  implementation(libs.androidx.browser)
  implementation(libs.androidx.core.ktx)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.ktor.client.okhttp)
  implementation(libs.ktor.client.content.negotiation)
  implementation(libs.ktor.serialization.kotlinx.json)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.ktor.client.mock)
}
