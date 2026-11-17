// SPDX-License-Identifier: AGPL-3.0-or-later
// Row packing for form questions. Shared by the form runtime and the
// form designer; it lives here so the designer's tree helpers can use
// it without importing the runtime component.
import type { Question } from '@gratis-gis/form-schema';

/**
 * Pack a list of questions into visual rows based on their declared
 * widths. A question with `full` (or unspecified) width starts a new
 * row by itself. Otherwise sequential questions are accumulated until
 * their summed widths exceed 1, then the row breaks.
 *
 * Only genuinely structural types are forced standalone (page break,
 * group, note, divider, hidden, image-display). Everything else,
 * including the wide ones like matrix and ranking, respects the
 * author's `layout.width`. If the author sets a matrix to 1/2 they
 * accept the cramped or scrolling consequence; that's an explicit
 * choice we shouldn't second-guess.
 */
export function packIntoRows(qs: Question[]): Question[][] {
  const rows: Question[][] = [];
  let current: Question[] = [];
  let used = 0;
  function flush() {
    if (current.length > 0) rows.push(current);
    current = [];
    used = 0;
  }
  for (const q of qs) {
    const isStandalone =
      q.type === 'page' ||
      q.type === 'group' ||
      q.type === 'note' ||
      q.type === 'divider' ||
      q.type === 'hidden' ||
      q.type === 'image-display';
    const w = widthFraction(q.layout?.width);
    if (isStandalone || w === 1) {
      flush();
      rows.push([q]);
      continue;
    }
    if (used + w > 1) flush();
    current.push(q);
    used += w;
  }
  flush();
  return rows;
}

function widthFraction(width: string | undefined): number {
  switch (width) {
    case 'half':
      return 1 / 2;
    case 'third':
      return 1 / 3;
    case 'two-thirds':
      return 2 / 3;
    case 'quarter':
      return 1 / 4;
    case 'three-quarters':
      return 3 / 4;
    case 'full':
    default:
      return 1;
  }
}
