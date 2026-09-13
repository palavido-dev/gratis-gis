// Root build file. Plugin versions come from gradle/libs.versions.toml;
// every module applies what it needs from there.
plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.compose.compiler) apply false
  alias(libs.plugins.kotlin.serialization) apply false
  alias(libs.plugins.ksp) apply false
  alias(libs.plugins.androidx.room) apply false
}
