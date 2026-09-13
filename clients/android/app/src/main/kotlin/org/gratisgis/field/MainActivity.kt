// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import org.gratisgis.field.theme.GratisGISFieldTheme
import org.gratisgis.field.ui.home.HomeScreen
import org.gratisgis.field.ui.home.HomeViewModel

class MainActivity : ComponentActivity() {

  private val viewModel: HomeViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    handleRedirect(intent)
    setContent {
      GratisGISFieldTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          HomeScreen(viewModel = viewModel)
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleRedirect(intent)
  }

  /** AuthCallbackActivity relaunches us with the redirect as data. */
  private fun handleRedirect(intent: Intent?) {
    val data = intent?.data ?: return
    if (data.scheme == "gratisgis" && data.host == "auth-callback") {
      viewModel.completeSignIn(data.toString())
      intent.data = null
    }
  }
}
