// SPDX-License-Identifier: AGPL-3.0-or-later
package org.gratisgis.field.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * Placeholder Material 3 theme. The real one is the Contour token set
 * from design_handoff_field_app/ and lands as :core:design; nothing
 * here should be styled against these defaults on purpose.
 */
@Composable
fun GratisGISFieldTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  content: @Composable () -> Unit,
) {
  MaterialTheme(
    colorScheme = if (darkTheme) darkColorScheme() else lightColorScheme(),
    content = content,
  )
}
