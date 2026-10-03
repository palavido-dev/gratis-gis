// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.ui.form

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun FormScreen(viewModel: FormViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
  val s by viewModel.state.collectAsStateWithLifecycle()
  Column(
    modifier = modifier.fillMaxSize().safeDrawingPadding().padding(24.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    TextButton(onClick = onBack) { Text("Back") }
    Text("Form · ${s.layerLabel}", style = MaterialTheme.typography.headlineSmall)
    Text("Draft ${s.draftId.take(8)}…", style = MaterialTheme.typography.bodySmall)
    if (s.busy) LinearProgressIndicator(Modifier.fillMaxWidth())

    if (s.fields.isEmpty() && s.error == null && !s.busy) {
      Text(
        "No renderable questions in this form (A1 skips geo/media). Use a form with text/integer fields.",
        style = MaterialTheme.typography.bodyMedium,
      )
    }

    s.fields.forEach { field ->
      OutlinedTextField(
        value = s.values[field.id].orEmpty(),
        onValueChange = { viewModel.setValue(field.id, it) },
        label = {
          Text(if (field.required) "${field.label} *" else field.label)
        },
        supportingText = { Text(field.type, style = MaterialTheme.typography.bodySmall) },
        singleLine = field.type != "text",
        modifier = Modifier.fillMaxWidth(),
      )
    }

    Button(onClick = viewModel::saveDraft, enabled = !s.busy && s.fields.isNotEmpty()) {
      Text("Save draft offline")
    }
    s.savedAt?.let {
      Text("Saved at $it", style = MaterialTheme.typography.bodySmall)
    }
    s.validationOk?.let { ok ->
      Text(
        if (ok) "Engine validate: ok" else "Engine validate: issues (draft still saved)",
        color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
      )
    }
    s.validationDetail?.let {
      Text(it, style = MaterialTheme.typography.bodySmall)
    }
    s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
  }
}
