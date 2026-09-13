// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.engine

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * Skeleton screen: proves the bundle loaded, was verified, and answers.
 * Replaced by the collection list (handoff screen 1b) once sign-in
 * exists; kept reachable from a diagnostics page after that.
 */
@Composable
fun EngineStatusScreen(
  modifier: Modifier = Modifier,
  viewModel: EngineStatusViewModel = viewModel(),
) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  Column(
    modifier = modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("GratisGIS Field", style = MaterialTheme.typography.headlineMedium)
    when (val s = state) {
      EngineStatus.Loading -> CircularProgressIndicator()
      is EngineStatus.Failed -> {
        Text("Engine failed to load", style = MaterialTheme.typography.titleMedium)
        Text(s.message, color = MaterialTheme.colorScheme.error)
      }
      is EngineStatus.Ready -> {
        Text("Engine v${s.engineVersion}", style = MaterialTheme.typography.titleMedium)
        Text("sha256 ${s.sha256.take(16)}", style = MaterialTheme.typography.bodySmall)
        Text("${s.functions} surface functions", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = viewModel::runSampleValidation) { Text("Validate a sample form") }
        s.sample?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
      }
    }
  }
}
