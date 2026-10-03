// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vendored markdown subset renderer (#45).
 *
 * Replaces `marked` for the help system. The help docs use a small,
 * well-defined subset of CommonMark + GFM, so owning the parser is
 * cheaper than carrying a 30k-LOC dependency with its own
 * versioning, supply-chain, and CVE surface. Inputs are always
 * trusted in-repo markdown (the content/help directory), never user
 * input. Outputs are HTML strings safe to inject via
 * dangerouslySetInnerHTML.
 *
 * Supported subset (informed by what content/help actually uses):
 *   - ATX headings `#` .. `######` with slugified ids that match the
 *     `slugify()` helper in help/content.ts (so in-page anchors line
 *     up with the TOC).
 *   - Paragraphs: consecutive non-blank lines, joined with a space.
 *   - Fenced code blocks: ```lang or just ```.
 *   - Unordered lists: `- foo` / `* foo` / `+ foo`. Tight by default.
 *   - Ordered lists: `1. foo`, `2. foo`. The starting number is
 *     preserved on the <ol>.
 *   - Bold (`**`), italic (`*`), inline code (`` ` ``).
 *   - Links `[text](url)` and images `![alt](url)`. URLs are
 *     attribute-escaped; only `http(s):`, mailto:, and relative URLs
 *     pass through unchanged.
 *   - Blockquotes `> ...` (recursive).
 *   - Horizontal rules: `---`, `***`, `___` on their own line.
 *   - GFM pipe tables: `| col | col |` followed by `|---|---|`.
 *   - HTML comments `<!-- ... -->` pass through verbatim. Other raw
 *     HTML is escaped.
 *
 * Anything outside this subset gets HTML-escaped and rendered as
 * plain text. That's intentional: if a new help doc reaches for a
 * feature we don't support, the failure mode is "looks plain" rather
 * than "renders someone's HTML untouched."
 */

/** Slugify text the same way help/content.ts's TOC extractor does,
 *  so anchor ids on rendered headings match the in-page navigation. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** HTML-escape a string. The five characters CommonMark requires
 *  escaping in raw HTML context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a URL for use inside an href / src attribute. We've
 *  already escaped < > & via escapeHtml; this is the additional
 *  pass to keep `"` out of the attribute and to neutralize the
 *  small handful of schemes we don't want to follow. */
function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  // Block javascript:, vbscript:, data: (except data:image), file:.
  // The help docs are trusted, but defense in depth costs nothing.
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:') ||
    (lower.startsWith('data:') && !lower.startsWith('data:image/'))
  ) {
    return '#';
  }
  return escapeHtml(trimmed);
}

/**
 * Inline pass. Walks the input character by character so we can
 * track nesting + run code spans first (which inhibit other
 * transforms). Returns HTML.
 *
 * Order matters:
 *   1. Code spans first (inline code suppresses everything else
 *      inside it; CommonMark rule).
 *   2. Then image + link patterns (so the bracket text doesn't get
 *      partially eaten by emphasis).
 *   3. Then strong (`**`) before emphasis (`*`) so `**x**` doesn't
 *      eat into a single-star emph pair.
 *
 * Everything outside transforms is HTML-escaped, so a raw `<` in
 * the markdown becomes `&lt;` in the output.
 */
function renderInline(src: string): string {
  // Tokenize: scan for code spans first and stash them with
  // placeholders so the rest of the pipeline can't mangle them.
  const codes: string[] = [];
  // Match the longest run of backticks first (CommonMark code span
  // rule): N backticks open, the same N close, content is whatever
  // is between (with leading/trailing single-space stripping when
  // both ends have a space and the content isn't all spaces).
  const codeSpanRe = /(`+)([\s\S]*?)\1(?!`)/g;
  let withCodes = src.replace(codeSpanRe, (_m, _ticks: string, body: string) => {
    let content = body;
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      content.trim().length > 0
    ) {
      content = content.slice(1, -1);
    }
    codes.push(`<code>${escapeHtml(content)}</code>`);
    return ` CODE${codes.length - 1} `;
  });

  // Images and links are stashed the same way code spans are. The
  // final pass HTML-escapes every remaining character, which is what
  // we want for prose and what we do not want for a tag we just built.
  withCodes = withCodes.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt: string, url: string, title?: string) => {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      codes.push(
        `<img src="${sanitizeUrl(url)}" alt="${escapeHtml(alt)}"${titleAttr}>`,
      );
      return ` CODE${codes.length - 1} `;
    },
  );

  // Links: [text](url) [text](url "title").
  withCodes = withCodes.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, text: string, url: string, title?: string) => {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      // Recursively render inline marks inside the link text. We
      // can't just escapeHtml here because the user wrote
      // `[**bold**](url)` expecting bold to render. Restore any
      // code-span placeholders before stashing the anchor, or the
      // outer pass would leave them as literal tokens inside the tag.
      const inner = renderInlineEscaped(text, codes).replace(
        / CODE(\d+) /g,
        (_mark, index: string) => codes[Number(index)] ?? '',
      );
      codes.push(
        `<a href="${sanitizeUrl(url)}"${titleAttr}>${inner}</a>`,
      );
      return ` CODE${codes.length - 1} `;
    },
  );

  return finishInline(withCodes, codes);
}

/**
 * Helper for inline text that is already known to be inside a
 * larger inline construct (like a link's display text). Reuses the
 * stashed code-span list so the placeholder restoration still works.
 */
function renderInlineEscaped(src: string, codes: string[]): string {
  return finishInline(src, codes, /* skipCodes */ true);
}

/**
 * Final inline pass: HTML-escape, run emphasis, restore code
 * placeholders. Pulled out so the link-text path can reuse it
 * without re-tokenizing code spans (those have already been pulled
 * out by the parent renderInline call).
 */
function finishInline(
  src: string,
  codes: string[],
  skipCodes = false,
): string {
  // The string may contain CODEi placeholders. Splitting on the
  // placeholder pattern lets us escape only the non-placeholder
  // segments. The placeholders themselves go straight through.
  const parts = src.split(/ CODE(\d+) /);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Plain segment: escape HTML, then apply emphasis transforms.
      let segment = escapeHtml(parts[i] ?? '');
      // Strong before emphasis. Pair-match across the whole
      // segment, but require the contents not to be empty so `****`
      // doesn't turn into `<strong></strong>`.
      segment = segment.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      segment = segment.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
      // Same patterns for underscore-style emphasis. CommonMark
      // requires word-boundary handling for `_`, which we approximate
      // by only firing when the `_` is at a word boundary.
      segment = segment.replace(/(^|\W)__([^_\n]+?)__(?=\W|$)/g, '$1<strong>$2</strong>');
      segment = segment.replace(/(^|\W)_([^_\n]+?)_(?=\W|$)/g, '$1<em>$2</em>');
      out.push(segment);
    } else {
      const idx = Number(parts[i]);
      if (skipCodes) {
        // Keep the placeholder intact; the outer renderInline call
        // will restore it after we return from the link text.
        out.push(` CODE${idx} `);
      } else {
        out.push(codes[idx] ?? '');
      }
    }
  }
  return out.join('');
}

/**
 * Top-level block parser. Walks a flat array of lines, identifies
 * the block at the current cursor, emits HTML for it, and advances.
 *
 * The line-based model handles every block we care about with one
 * sweep. Frontmatter is the only construct that needs lookahead
 * across many lines, and the help loader strips it before we get
 * the body, so we never see it here.
 */
function renderBlocks(lines: string[], startIdx = 0, endIdx?: number): {
  html: string;
  next: number;
} {
  const end = endIdx ?? lines.length;
  let i = startIdx;
  const out: string[] = [];

  while (i < end) {
    const line = lines[i] ?? '';

    // Blank line: skip.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block: ``` or ```lang. Closes at the next ``` on
    // its own line (lang optional and ignored for class).
    const fenceOpen = line.match(/^```(\w+)?\s*$/);
    if (fenceOpen) {
      const lang = fenceOpen[1] ?? '';
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      const body: string[] = [];
      i++;
      while (i < end && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      // Consume the closing fence if we found one. If we hit EOF
      // first, render what we have anyway -- that matches `marked`'s
      // behavior on unterminated fences.
      if (i < end) i++;
      out.push(
        `<pre><code${langClass}>${escapeHtml(body.join('\n'))}\n</code></pre>`,
      );
      continue;
    }

    // ATX heading: 1-6 hashes, then space, then text. A trailing
    // `#####` run is stripped (CommonMark optional close).
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const depth = heading[1]!.length;
      const text = heading[2]!;
      out.push(
        `<h${depth} id="${escapeHtml(slugify(text))}">${renderInline(text)}</h${depth}>`,
      );
      i++;
      continue;
    }

    // Horizontal rule: `---`, `***`, or `___` on its own line. The
    // line must be 3+ of the same character with optional trailing
    // whitespace and nothing else.
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // HTML comment: pass through unchanged (single-line for now;
    // help docs only use the one-liner form).
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    // GFM pipe table: header row, then a separator row of `|---|`,
    // then body rows. The separator row determines column count and
    // alignment.
    if (line.includes('|') && i + 1 < end) {
      const sep = lines[i + 1] ?? '';
      const sepMatch = sep
        .trim()
        .match(/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/);
      if (sepMatch) {
        const headerCells = parseTableRow(line);
        const aligns = parseTableAlign(sep);
        const bodyRows: string[][] = [];
        i += 2;
        while (i < end) {
          const row = lines[i] ?? '';
          if (row.trim() === '' || !row.includes('|')) break;
          bodyRows.push(parseTableRow(row));
          i++;
        }
        const thead = headerCells
          .map((c, idx) => {
            const align = aligns[idx];
            const attr = align ? ` style="text-align:${align}"` : '';
            return `<th${attr}>${renderInline(c)}</th>`;
          })
          .join('');
        const tbody = bodyRows
          .map((row) => {
            const tds = headerCells
              .map((_h, idx) => {
                const cell = row[idx] ?? '';
                const align = aligns[idx];
                const attr = align ? ` style="text-align:${align}"` : '';
                return `<td${attr}>${renderInline(cell)}</td>`;
              })
              .join('');
            return `<tr>${tds}</tr>`;
          })
          .join('');
        out.push(
          `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`,
        );
        continue;
      }
    }

    // Blockquote: `> foo` continues across consecutive `> ` lines.
    // Body is recursively rendered (so a blockquote can contain its
    // own paragraphs, lists, etc.).
    if (/^>\s?/.test(line)) {
      const bqLines: string[] = [];
      while (i < end && /^>\s?/.test(lines[i] ?? '')) {
        bqLines.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i++;
      }
      const inner = renderBlocks(bqLines).html;
      out.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Unordered list: `- ` / `* ` / `+ ` at line start. List items
    // continue across consecutive matching lines, plus indented
    // continuation lines (two spaces / tab) which are folded into
    // the previous item's body.
    const ulHead = line.match(/^([-*+])\s+(.*)$/);
    if (ulHead) {
      const items = collectListItems(lines, i, end, 'ul');
      i = items.next;
      out.push(renderList(items.items, 'ul'));
      continue;
    }

    // Ordered list: `1. ` style. The starting number is preserved on
    // the <ol> for round-trip fidelity.
    const olHead = line.match(/^(\d+)\.\s+(.*)$/);
    if (olHead) {
      const start = Number(olHead[1]);
      const items = collectListItems(lines, i, end, 'ol');
      i = items.next;
      const startAttr = start !== 1 ? ` start="${start}"` : '';
      out.push(renderList(items.items, 'ol', startAttr));
      continue;
    }

    // Paragraph: gather consecutive non-blank lines until we hit a
    // blank line, a heading, a fence, a list, an HR, a blockquote,
    // or a table.
    const para: string[] = [line];
    i++;
    while (i < end) {
      const next = lines[i] ?? '';
      if (next.trim() === '') break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^```/.test(next)) break;
      if (/^([-*+])\s+/.test(next)) break;
      if (/^\d+\.\s+/.test(next)) break;
      if (/^>\s?/.test(next)) break;
      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break;
      // Table separator: only break if the current line is the
      // table header (i.e. has pipes and the next-next-next line
      // also has pipes). Cheap heuristic: if THIS line is being
      // consumed as a paragraph and the next looks like `|---|`,
      // stop and let the outer loop handle it as a table.
      if (next.includes('|') && /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(next.trim()) && para[para.length - 1]?.includes('|')) {
        // Roll back: the last line of `para` is actually the table
        // header. Re-process from there.
        i--;
        para.pop();
        break;
      }
      para.push(next);
      i++;
    }
    if (para.length > 0) {
      // Join with a space (CommonMark "loose" paragraph join). The
      // help docs are wrapped at ~70 chars; joining with newline
      // would break inline marks that span wraps.
      const joined = para.join(' ');
      out.push(`<p>${renderInline(joined)}</p>`);
    }
  }

  return { html: out.join('\n'), next: i };
}

/** Split a pipe-table row into its cells. Handles a leading and
 *  trailing pipe; escaped pipes (`\|`) inside cells are preserved as
 *  a literal `|` in the cell text. */
function parseTableRow(row: string): string[] {
  const trimmed = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** Read alignment from a table separator row. */
function parseTableAlign(sep: string): Array<'left' | 'right' | 'center' | null> {
  return parseTableRow(sep).map((cell) => {
    const t = cell.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * Collect consecutive list items starting at `start`. An item is
 * one marker line plus any continuation lines. Returns the items'
 * raw bodies so renderList can drive a recursive renderBlocks()
 * call for each one (which gives us nested lists + paragraph-in-
 * list support for free).
 *
 * Continuation rules (CommonMark "lazy continuation," loosened):
 *   - An indented line (>= 2 spaces or a tab) folds in with the
 *     indent stripped. This is the standard nested-content path.
 *   - A line indented just 1 space also folds in. The help docs
 *     wrap list items at column ~70 with a 1-space hanging indent,
 *     which is technically below CommonMark's threshold but is the
 *     natural wrapping the source files use.
 *   - A non-indented line that doesn't start a new block (heading,
 *     fence, list, hr, blockquote) folds in lazily.
 *   - A blank line followed by an indented line continues a "loose"
 *     list item with its own paragraph break.
 *   - Anything else ends the list item (and the list, if it's not
 *     a new marker).
 */
function collectListItems(
  lines: string[],
  start: number,
  end: number,
  kind: 'ul' | 'ol',
): { items: string[][]; next: number } {
  const headRe = kind === 'ul' ? /^([-*+])\s+(.*)$/ : /^(\d+)\.\s+(.*)$/;
  const items: string[][] = [];
  let i = start;
  while (i < end) {
    const line = lines[i] ?? '';
    const m = line.match(headRe);
    if (!m) break;
    const body: string[] = [m[2] ?? ''];
    i++;
    while (i < end) {
      const next = lines[i] ?? '';
      if (next.trim() === '') {
        // Blank line: peek at the next non-blank. If it's indented,
        // it's a continuation of this list item with a paragraph
        // break in the middle.
        const peek = lines[i + 1] ?? '';
        if (/^( {2,}|\t)/.test(peek)) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      // Indented (2+ spaces or tab): standard nested continuation.
      if (/^( {2,}|\t)/.test(next)) {
        body.push(next.replace(/^( {2,}|\t)/, ''));
        i++;
        continue;
      }
      // New marker (same list, next item): stop this item, let the
      // outer loop pick it up.
      if (headRe.test(next)) break;
      // Block boundaries: a heading, fence, HR, or blockquote ends
      // the list outright.
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^```/.test(next)) break;
      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break;
      if (/^>\s?/.test(next)) break;
      // 1-space-indented continuation (the help-docs wrap style),
      // OR a non-indented lazy continuation (CommonMark "lazy
      // continuation lines"). Strip up to one leading space so the
      // joined line reads naturally.
      body.push(next.replace(/^ /, ''));
      i++;
    }
    items.push(body);
  }
  return { items, next: i };
}

/** Render a parsed list. Each item's body is fed back through
 *  renderBlocks() so it can contain paragraphs, sub-lists, code
 *  blocks, etc. Tight lists (no blank lines anywhere) get an
 *  inline-only treatment so single-line items don't end up wrapped
 *  in a stray <p>. */
function renderList(items: string[][], tag: 'ul' | 'ol', extraAttr = ''): string {
  const isTight = items.every((it) => !it.some((l) => l === ''));
  const lis = items.map((body) => {
    if (isTight) {
      // Tight item: join continuation lines with a space (CommonMark
      // paragraph-join inside an item). Lazy continuation produced
      // multi-line bodies for wrapped list items in the help docs;
      // this keeps the output looking like one logical bullet.
      const joined = body.join(' ');
      return `<li>${renderInline(joined)}</li>`;
    }
    const inner = renderBlocks(body).html;
    return `<li>${inner}</li>`;
  });
  return `<${tag}${extraAttr}>${lis.join('')}</${tag}>`;
}

/**
 * Public entry point. Normalizes line endings and feeds the body
 * to the block parser.
 *
 * Stable, synchronous interface so the help loader can do
 * `const html = renderMarkdown(parsed.content)` in place of
 * `await marked.parse(parsed.content)`.
 */
export function renderMarkdown(input: string): string {
  if (!input) return '';
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // Trim a trailing empty line so the last block doesn't get a
  // dangling <p></p>.
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
    lines.pop();
  }
  const { html } = renderBlocks(lines);
  return html;
}
