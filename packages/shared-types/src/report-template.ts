// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Report templates: a document filled once per feature, such as an
 * inspection report for each submission of a form.
 *
 * The body is plain text with a little Markdown (headings, bold,
 * italic, lists, tables, rules) and placeholders:
 *
 *   {{field}}            a field's value (pick list fields show the label)
 *   {{= expression }}    any expression, with related records, other
 *                        layers and nearby features
 *   {{photos}}           the feature's photo attachments
 *
 * Rendering is split so the server and the editor's preview agree:
 * `parseReportBody` finds the placeholders, the server works out
 * their values, and `renderReportHtml` turns the body and the values
 * into HTML. Every value is escaped; the template cannot add raw HTML.
 */

export const REPORT_PAGE_SIZES = ['letter', 'legal', 'a4', 'a3', 'tabloid'] as const;
export type ReportPageSize = (typeof REPORT_PAGE_SIZES)[number];

/** Stored in an Item's data when `type = 'report_template'`. */
export interface ReportTemplateData {
  version: 1;
  /**
   * The data layer the report is for. One entry; an array so the
   * dependency extractor reads it the same way as other items.
   */
  sources: Array<{ itemId: string; layerKey: string }>;
  /** The template text. */
  body: string;
  page: {
    size: ReportPageSize;
    orientation: 'portrait' | 'landscape';
  };
  /** File name for the PDF. Defaults to the template title. */
  fileName?: string;
}

/** A starting body: a title and a table of every field, then the photos. */
export function defaultReportBody(
  title: string,
  fields: ReadonlyArray<{ name: string; label?: string }>,
): string {
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
  const rows = fields.map((f) => `| ${cell(f.label || f.name)} | {{${f.name}}} |`);
  return [
    `# ${title.replace(/\n/g, ' ')}`,
    '',
    '| Field | Value |',
    '|---|---|',
    ...rows,
    '',
    '{{photos}}',
    '',
  ].join('\n');
}

/**
 * Check and tidy a report template's data before it is stored.
 * Returns an error message, or the cleaned data. A template may be
 * saved before its layer is picked (no sources yet).
 */
export function normalizeReportTemplate(
  data: unknown,
): { data: ReportTemplateData } | { error: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { error: 'Report template data must be an object.' };
  const d = data as Record<string, unknown>;
  const body = d.body ?? '';
  if (typeof body !== 'string') return { error: 'The report body must be text.' };
  if (body.length > MAX_REPORT_BODY)
    return { error: `A report template is at most ${MAX_REPORT_BODY} characters.` };
  const rawSources = d.sources ?? [];
  if (!Array.isArray(rawSources) || rawSources.length > 1)
    return { error: 'A report template reports on one layer.' };
  const sources: ReportTemplateData['sources'] = [];
  for (const src of rawSources as unknown[]) {
    const r = (src ?? {}) as Record<string, unknown>;
    if (typeof r.itemId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.itemId))
      return { error: 'The report layer is not a valid item.' };
    if (typeof r.layerKey !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(r.layerKey)) {
      return { error: 'The report layer key is not valid.' };
    }
    sources.push({ itemId: r.itemId, layerKey: r.layerKey });
  }
  const page = (d.page ?? {}) as Record<string, unknown>;
  const size = REPORT_PAGE_SIZES.includes(page.size as ReportPageSize)
    ? (page.size as ReportPageSize)
    : 'letter';
  const orientation = page.orientation === 'landscape' ? 'landscape' : 'portrait';
  const out: ReportTemplateData = { version: 1, sources, body, page: { size, orientation } };
  if (typeof d.fileName === 'string' && d.fileName.trim())
    out.fileName = d.fileName.trim().slice(0, 200);
  return { data: out };
}

/** Most features in one generated PDF. */
export const MAX_REPORT_FEATURES = 100;
/** Longest template body, in characters. */
export const MAX_REPORT_BODY = 50_000;
/** Most placeholders in one body. */
export const MAX_REPORT_PLACEHOLDERS = 200;

export type ReportPlaceholder =
  { kind: 'field'; name: string } | { kind: 'expression'; source: string } | { kind: 'photos' };

export type ReportSegment = { text: string } | { placeholder: number };

export interface ParsedReportBody {
  segments: ReportSegment[];
  placeholders: ReportPlaceholder[];
}

/**
 * Split a body into text and placeholders. An expression placeholder
 * runs to the first `}}` that is not inside quotes or a `{{field}}`
 * reference, so `{{= coalesce({{a}}, 'x') }}` reads as one expression.
 */
export function parseReportBody(body: string): ParsedReportBody {
  const segments: ReportSegment[] = [];
  const placeholders: ReportPlaceholder[] = [];
  let text = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('{{', i)) {
      const end = placeholderEnd(body, i + 2);
      if (end !== -1) {
        const inner = body.slice(i + 2, end).trim();
        const ph = classify(inner);
        if (ph && placeholders.length < MAX_REPORT_PLACEHOLDERS) {
          if (text) segments.push({ text });
          text = '';
          segments.push({ placeholder: placeholders.length });
          placeholders.push(ph);
          i = end + 2;
          continue;
        }
      }
    }
    text += body[i];
    i += 1;
  }
  if (text) segments.push({ text });
  return { segments, placeholders };
}

function classify(inner: string): ReportPlaceholder | null {
  if (inner.startsWith('=')) {
    const source = inner.slice(1).trim();
    return source ? { kind: 'expression', source } : null;
  }
  if (inner.toLowerCase() === 'photos') return { kind: 'photos' };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return { kind: 'field', name: inner };
  return null;
}

/** Index of the closing `}}`, skipping quoted text and nested `{{name}}`. */
function placeholderEnd(s: string, from: number): number {
  let quote: string | null = null;
  let depth = 0;
  for (let j = from; j < s.length; j += 1) {
    const ch = s[j]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (s.startsWith('{{', j)) {
      depth += 1;
      j += 1;
    } else if (s.startsWith('}}', j)) {
      if (depth === 0) return j;
      depth -= 1;
      j += 1;
    } else if (ch === '\n' && depth === 0 && !s.slice(from, j).trimStart().startsWith('=')) {
      // A field placeholder does not span lines.
      return -1;
    }
  }
  return -1;
}

/** A placeholder's value for one feature. */
export type ReportValue = { text: string } | { images: Array<{ src: string; caption: string }> };

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marks where a placeholder sits while the Markdown is rendered. */
const MARK = '\uE000';

/**
 * Render a parsed body with one feature's values to HTML. `values`
 * is indexed like `parsed.placeholders`. Image sources are used as
 * given, so the caller supplies data: URIs or its own URLs.
 */
export function renderReportHtml(
  parsed: ParsedReportBody,
  values: ReadonlyArray<ReportValue | null>,
): string {
  // Placeholders become markers, the Markdown is rendered with every
  // character escaped, then the markers become escaped values. A
  // value can therefore never become Markdown or HTML.
  const marked = parsed.segments
    .map((seg) =>
      'text' in seg ? seg.text.split(MARK).join('') : `${MARK}${seg.placeholder}${MARK}`,
    )
    .join('');
  const html = markdownToHtml(marked);
  return html.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => {
    const v = values[Number(n)];
    if (!v) return '';
    if ('text' in v) return escapeHtml(v.text).replace(/\n/g, '<br>');
    if (v.images.length === 0) return '';
    return `<div class="photos">${v.images
      .map(
        (img) =>
          `<figure><img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.caption)}"><figcaption>${escapeHtml(img.caption)}</figcaption></figure>`,
      )
      .join('')}</div>`;
  });
}

/** Turn a computed value into report text. */
export function reportText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(reportText).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------
// A small Markdown subset. Everything is escaped first; only the
// structures below produce tags.
// ---------------------------------------------------------------

function inline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
  return out;
}

function tableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isTableRule = (line: string) =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (t === '\\pagebreak' || t === '<!-- pagebreak -->') {
      flush();
      out.push('<div class="page-break"></div>');
      continue;
    }
    if (/^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!.trim();
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(l) : /^[-*]\s+(.*)$/.exec(l);
        if (!m) break;
        items.push(`<li>${inline(m[1]!)}</li>`);
        i += 1;
      }
      i -= 1;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (t.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      flush();
      const head = tableRow(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(tableRow(lines[i]!));
        i += 1;
      }
      i -= 1;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_c, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    para.push(t);
  }
  flush();
  return out.join('\n');
}

/** Page CSS shared by the PDF and the editor's preview. */
export const REPORT_CSS = `
body { font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1a1f1e; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 8pt; } h2 { font-size: 15pt; margin: 14pt 0 6pt; }
h3 { font-size: 12.5pt; margin: 12pt 0 4pt; } h4 { font-size: 11pt; margin: 10pt 0 4pt; }
p { margin: 0 0 8pt; } ul, ol { margin: 0 0 8pt 18pt; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; }
th, td { border: 1px solid #c9d1ce; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eef2f0; }
hr { border: 0; border-top: 1px solid #c9d1ce; margin: 10pt 0; }
.photos { display: flex; flex-wrap: wrap; gap: 8pt; margin: 6pt 0 10pt; }
.photos figure { margin: 0; width: calc(50% - 4pt); break-inside: avoid; }
.photos img { width: 100%; height: auto; border: 1px solid #c9d1ce; }
.photos figcaption { font-size: 8.5pt; color: #55605d; }
.page-break { break-after: page; }
.report + .report { break-before: page; }
`;
