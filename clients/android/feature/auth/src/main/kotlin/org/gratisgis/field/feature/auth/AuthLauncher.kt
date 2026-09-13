// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import android.content.Context
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
import io.ktor.http.Url

/** Opens the authorization URL in a Custom Tab (falls back to any
 *  browser when none supports Custom Tabs). */
object AuthLauncher {
  fun open(context: Context, url: Url) {
    val uri = url.toString().toUri()
    val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
    tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    tab.launchUrl(context, uri)
  }
}
