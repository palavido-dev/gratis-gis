// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * Placeholder UI for the skeleton. The handoff's screens 1a (sign in)
 * and 1b (collections) replace this once :core:design exists; nothing
 * here is styled on purpose.
 */
@Composable
fun HomeScreen(viewModel: HomeViewModel, modifier: Modifier = Modifier) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  Column(
    modifier = modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("GratisGIS Field", style = MaterialTheme.typography.headlineMedium)
    Text(
      when {
        state.engineError != null -> "Engine failed: ${state.engineError}"
        state.engineVersion != null -> "Engine v${state.engineVersion}"
        else -> "Loading engine"
      },
      style = MaterialTheme.typography.bodySmall,
    )
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())

    if (state.signedInAs == null) {
      OutlinedTextField(
        value = state.portalUrl,
        onValueChange = viewModel::setPortalUrl,
        label = { Text("Portal URL") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      state.portal?.let { Text("${it.name} (v${it.version})", style = MaterialTheme.typography.bodyMedium) }
      Button(onClick = viewModel::signIn, enabled = !state.busy) { Text("Sign in") }
    } else {
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Signed in as ${state.signedInAs}", style = MaterialTheme.typography.bodyMedium)
      }
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = viewModel::loadCollections, enabled = !state.busy) { Text("Refresh") }
        OutlinedButton(onClick = viewModel::signOut) { Text("Sign out") }
      }
      Text("Collections (${state.collections.size})", style = MaterialTheme.typography.titleMedium)
      LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(state.collections, key = { it.id }) { item ->
          Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
              Text(item.title, style = MaterialTheme.typography.titleSmall)
              item.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
              }
            }
          }
        }
      }
    }
    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
  }
}
