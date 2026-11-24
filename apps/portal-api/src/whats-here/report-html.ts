// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ReportAreaUnit,
  ReportLabels,
  ReportLengthUnit,
} from './report-request.js';

/**
 * The What's Here report as HTML for Chromium to print (#796).
 *
 * Laid out against what the WAB Screening report got wrong: the
 * answer is on page 1 (facts, map, summary) instead of after a blank
 * page; layers with nothing in the area go on one line instead of rows
 * of zeros; and the shapes the area was built from are listed by name.
 *
 * Pure and escaped throughout: every string in it came from a user,
 * a layer's data or a field name.
 */

export interface ReportRow {
  /** null on a layer's own row, and for a breakdown's empty value. */
  value: string | null;
  count: number;
  /** m² for polygons, m for lines, null for points. */
  measure: number | null;
  /** Added-up number fields, in the layer's sumLabels order. */
  sums?: Array<number | null>;
}

export interface ReportLayer {
  title: string;
  geometry: 'point' | 'line' | 'polygon' | null;
  /** Absent when the layer could not be read. */
  total?: ReportRow;
  /** Labels of the number fields this layer adds up. */
  sumLabels?: string[];
  breakdown?: { fieldLabel: string; rows: ReportRow[]; truncated: boolean };
}

export interface ReportDoc {
  title: string;
  generatedAt: Date;
  locale: string;
  timeZone: string;
  labels: ReportLabels;
  areaSquareMeters: number;
  distanceMeters: number;
  place?: string;
  picked: string[];
  mapImage?: string;
  areaUnit: ReportAreaUnit;
  lengthUnit: ReportLengthUnit;
  layers: ReportLayer[];
}

const SQM_PER: Record<ReportAreaUnit, number> = {
  'square-meters': 1,
  hectares: 10_000,
  'square-kilometers': 1_000_000,
  'square-feet': 0.09290304,
  acres: 4046.8564224,
  'square-miles': 2_589_988.110336,
};
const AREA_SUFFIX: Record<ReportAreaUnit, string> = {
  'square-meters': 'm²',
  hectares: 'ha',
  'square-kilometers': 'km²',
  'square-feet': 'ft²',
  acres: 'ac',
  'square-miles': 'mi²',
};
const M_PER: Record<ReportLengthUnit, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  miles: 1609.344,
};
const LENGTH_SUFFIX: Record<ReportLengthUnit, string> = {
  meters: 'm',
  kilometers: 'km',
  feet: 'ft',
  miles: 'mi',
};

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function number(n: number, locale: string): string {
  // Fewer decimals as the number grows: 0.42 ac, 12.6 ac, 1,204 ac.
  const digits = n === 0 ? 0 : n < 10 ? 2 : n < 1000 ? 1 : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
}

export function formatArea(sqm: number, unit: ReportAreaUnit, locale: string): string {
  return `${number(sqm / SQM_PER[unit], locale)} ${AREA_SUFFIX[unit]}`;
}

export function formatLength(m: number, unit: ReportLengthUnit, locale: string): string {
  return `${number(m / M_PER[unit], locale)} ${LENGTH_SUFFIX[unit]}`;
}

/** Share of the area, for polygon layers. Capped at 100: overlapping
 *  features in one layer can sum past the area itself. */
function percent(row: ReportRow, layer: ReportLayer, areaSqm: number, locale: string): string {
  if (layer.geometry !== 'polygon' || row.measure === null || areaSqm <= 0) return '';
  const p = Math.min(100, (row.measure / areaSqm) * 100);
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: p < 10 ? 1 : 0 }).format(p)}%`;
}

function measure(row: ReportRow, layer: ReportLayer, doc: ReportDoc): { area: string; length: string } {
  if (row.measure === null) return { area: '', length: '' };
  if (layer.geometry === 'polygon') return { area: formatArea(row.measure, doc.areaUnit, doc.locale), length: '' };
  if (layer.geometry === 'line') return { area: '', length: formatLength(row.measure, doc.lengthUnit, doc.locale) };
  return { area: '', length: '' };
}

export const WHATS_HERE_REPORT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; font-size: 10pt; margin: 0; }
  h1 { font-size: 17pt; margin: 0 0 2pt; }
  h2 { font-size: 11.5pt; margin: 16pt 0 5pt; }
  .meta { color: #6b7280; font-size: 9pt; margin-bottom: 10pt; }
  .facts { display: flex; flex-wrap: wrap; gap: 6pt 18pt; margin: 0 0 10pt; }
  .fact .k { color: #6b7280; font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; }
  .fact .v { font-size: 11pt; font-weight: bold; }
  .map { width: 100%; max-height: 4.3in; object-fit: contain; border: 1px solid #d1d5db; display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 4pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { text-align: left; padding: 4pt 6pt; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { background: #f3f4f6; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .03em; color: #4b5563; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .note { color: #6b7280; font-size: 9pt; margin-top: 6pt; }
  .unavailable { color: #b91c1c; }
  .picked { columns: 3; column-gap: 14pt; font-size: 9pt; margin: 2pt 0 0; padding-left: 14pt; }
  section.breakdown { page-break-inside: avoid; }
  tr.sums td { border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 9pt; padding-top: 0; }
`;

function amount(v: number | null | undefined, locale: string): string {
  if (v === null || v === undefined) return '–';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
}

export function renderWhatsHereReport(doc: ReportDoc): string {
  const L = doc.labels;
  const totalOf = (label: string) => L.totalOf.replace('{label}', label);
  const found = doc.layers.filter((l) => l.total && l.total.count > 0);
  const empty = doc.layers.filter((l) => l.total && l.total.count === 0);
  const unreadable = doc.layers.filter((l) => !l.total);
  const showArea = found.some((l) => l.geometry === 'polygon');
  const showLength = found.some((l) => l.geometry === 'line');

  const when = new Intl.DateTimeFormat(doc.locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: doc.timeZone,
  }).format(doc.generatedAt);

  const facts: Array<[string, string]> = [
    [L.area, formatArea(doc.areaSquareMeters, doc.areaUnit, doc.locale)],
    [
      L.distance,
      doc.distanceMeters > 0 ? formatLength(doc.distanceMeters, doc.lengthUnit, doc.locale) : L.onlyInside,
    ],
  ];
  if (doc.place) facts.push([L.place, doc.place]);

  const head = (cols: string[]) =>
    `<tr>${cols.map((c, i) => `<th${i > 0 ? ' class="n"' : ''}>${esc(c)}</th>`).join('')}</tr>`;
  const cols = [L.layer, L.count, ...(showArea ? [L.areaCol, L.percentCol] : []), ...(showLength ? [L.lengthCol] : [])];

  const summaryRows = found
    .map((layer) => {
      const row = layer.total!;
      const m = measure(row, layer, doc);
      const cells = [
        `<td>${esc(layer.title)}</td>`,
        `<td class="n">${number(row.count, doc.locale)}</td>`,
        ...(showArea
          ? [`<td class="n">${esc(m.area)}</td>`, `<td class="n">${esc(percent(row, layer, doc.areaSquareMeters, doc.locale))}</td>`]
          : []),
        ...(showLength ? [`<td class="n">${esc(m.length)}</td>`] : []),
      ];
      // Added-up fields differ per layer, so they go on a line of
      // their own under the layer rather than as shared columns.
      const sumLine =
        layer.sumLabels && layer.sumLabels.length > 0
          ? `<tr class="sums"><td colspan="${cells.length}">${layer.sumLabels
              .map((label, i) => `${esc(totalOf(label))} ${esc(amount(row.sums?.[i], doc.locale))}`)
              .join(' · ')}</td></tr>`
          : '';
      return `<tr>${cells.join('')}</tr>${sumLine}`;
    })
    .join('');

  const breakdowns = found
    .filter((l) => l.breakdown && l.breakdown.rows.length > 0)
    .map((layer) => {
      const b = layer.breakdown!;
      const bArea = layer.geometry === 'polygon';
      const bLength = layer.geometry === 'line';
      const sumLabels = layer.sumLabels ?? [];
      const bCols = [
        b.fieldLabel,
        L.count,
        ...(bArea ? [L.areaCol, L.percentCol] : []),
        ...(bLength ? [L.lengthCol] : []),
        ...sumLabels.map(totalOf),
      ];
      const rows = b.rows
        .map((r) => {
          const m = measure(r, layer, doc);
          return `<tr><td>${r.value === null ? `<em>${esc(L.noValue)}</em>` : esc(r.value)}</td><td class="n">${number(r.count, doc.locale)}</td>${
            bArea
              ? `<td class="n">${esc(m.area)}</td><td class="n">${esc(percent(r, layer, doc.areaSquareMeters, doc.locale))}</td>`
              : ''
          }${bLength ? `<td class="n">${esc(m.length)}</td>` : ''}${sumLabels
            .map((_, i) => `<td class="n">${esc(amount(r.sums?.[i], doc.locale))}</td>`)
            .join('')}</tr>`;
        })
        .join('');
      return `<section class="breakdown"><h2>${esc(layer.title)} · ${esc(L.breakdownBy)} ${esc(b.fieldLabel)}</h2><table><thead>${head(bCols)}</thead><tbody>${rows}</tbody></table>${
        b.truncated ? `<p class="note">${esc(L.truncated)}</p>` : ''
      }</section>`;
    })
    .join('');

  return `<!doctype html><html lang="${esc(doc.locale)}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${WHATS_HERE_REPORT_CSS}</style></head><body>
<h1>${esc(doc.title)}</h1>
<div class="meta">${esc(L.generated)} ${esc(when)}</div>
<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
${doc.mapImage ? `<img class="map" src="${esc(doc.mapImage)}" alt="">` : ''}
${found.length > 0 ? `<table><thead>${head(cols)}</thead><tbody>${summaryRows}</tbody></table>` : ''}
${empty.length > 0 ? `<p class="note">${esc(L.nothingIn)} ${esc(empty.map((l) => l.title).join(', '))}</p>` : ''}
${unreadable.length > 0 ? `<p class="note unavailable">${esc(L.unavailable)} ${esc(unreadable.map((l) => l.title).join(', '))}</p>` : ''}
${found.some((l) => (l.sumLabels?.length ?? 0) > 0) ? `<p class="note">${esc(L.sumNote)}</p>` : ''}
${doc.picked.length > 0 ? `<h2>${esc(L.picked)}</h2><ul class="picked">${doc.picked.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
${breakdowns}
</body></html>`;
}
