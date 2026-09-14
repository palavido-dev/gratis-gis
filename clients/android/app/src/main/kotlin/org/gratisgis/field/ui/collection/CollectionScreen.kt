// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.collection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun CollectionScreen(viewModel: CollectionViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
  val s by viewModel.state.collectAsStateWithLifecycle()
  Column(
    modifier = modifier.fillMaxSize().safeDrawingPadding().padding(24.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    TextButton(onClick = onBack) { Text("Back") }
    Text(s.collection.title, style = MaterialTheme.typography.headlineSmall)
    if (s.busy) LinearProgressIndicator(Modifier.fillMaxWidth())

    Text("Offline", style = MaterialTheme.typography.titleMedium)
    Text(
      if (s.downloadedAt == null) "Not downloaded"
      else "Downloaded ${s.downloadedAt}: ${s.layers.size} layers, ${s.featureCount} features, ${s.packages.size} basemap packages",
      style = MaterialTheme.typography.bodyMedium,
    )
    s.packages.forEach { Text("  ${it.areaName}: ${it.sizeBytes / 1024} KB", style = MaterialTheme.typography.bodySmall) }
    s.progress?.let { p ->
      Text(
        "${p.phase} ${p.detail} (layers ${p.layers}, features ${p.features}, forms ${p.forms}" +
          (p.packageTotal?.let { ", package ${p.packageBytes / 1024}/${it / 1024} KB" } ?: "") + ")",
        style = MaterialTheme.typography.bodySmall,
      )
      p.shortfalls.forEach { Text("  shortfall: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
    Button(onClick = viewModel::download, enabled = !s.busy) { Text("Download offline") }

    Text("Queue (${s.queue.size})", style = MaterialTheme.typography.titleMedium)
    s.queue.forEach { row ->
      Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
          Text("${row.op} ${row.globalId.take(8)} on ${row.layerKey}: ${row.syncStatus}", style = MaterialTheme.typography.bodyMedium)
          row.failureJson?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
          row.conflictCurrentJson?.let {
            Text("server now has: ${it.take(200)}", style = MaterialTheme.typography.bodySmall)
          }
          if (row.syncStatus == "rejected") {
            TextButton(onClick = { viewModel.discardRejected(row) }) { Text("Discard") }
          }
        }
      }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      OutlinedButton(onClick = viewModel::queueTestRecord, enabled = !s.busy) { Text("Queue test record") }
      Button(onClick = viewModel::syncNow, enabled = !s.busy) { Text("Sync now") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      OutlinedButton(onClick = { viewModel.queueTestEdit(stale = false) }, enabled = !s.busy) { Text("Queue edit") }
      OutlinedButton(onClick = { viewModel.queueTestEdit(stale = true) }, enabled = !s.busy) { Text("Queue stale edit") }
    }
    s.lastSync?.let { r ->
      Text(
        "Last sync: processed ${r.processed}, synced ${r.synced}, failed ${r.failed}, rejected ${r.rejected}, remaining ${r.remaining}",
        style = MaterialTheme.typography.bodySmall,
      )
    }

    Text("Engine", style = MaterialTheme.typography.titleMedium)
    OutlinedButton(onClick = viewModel::benchmark, enabled = !s.busy) { Text("Benchmark engine calls") }
    s.benchmark?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

    s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
  }
}
