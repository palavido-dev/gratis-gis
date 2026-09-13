// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.feature.auth

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Lands the `gratisgis://auth-callback` redirect and forwards it to
 * the app's launcher activity as that intent's data, then finishes.
 * Knows nothing about which activity that is, so :app owns its own
 * navigation; the launcher activity reads `intent.data` and calls
 * [AuthSession.completeSignIn].
 */
class AuthCallbackActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch != null) {
      launch.data = intent.data
      launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(launch)
    }
    finish()
  }
}
