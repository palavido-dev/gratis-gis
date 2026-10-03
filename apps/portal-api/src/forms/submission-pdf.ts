// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plain-text PDF receipt for one form submission.
 *
 * This is not the map print path and not a report template. It
 * writes a small PDF 1.4 file with Helvetica so a form owner can
 * download the answers without a Chromium sidecar.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const TOP = PAGE_H - MARGIN;
const BOTTOM = MARGIN;

export interface ReceiptLine {
  label: string;
  value: string;
}

export interface SubmissionReceipt {
  title: string;
  capturedAt: string;
  lines: ReceiptLine[];
}

interface Drawn {
  text: string;
  font: 'F1' | 'F2';
  size: number;
  leading: number;
}

export function formatSubmissionReceipt(args: {
  title: string;
  capturedAt: string;
  submissionId: string;
  questions: unknown;
  response: unknown;
}): SubmissionReceipt {
  const labels = new Map<string, string>();
  collectLabels(args.questions, labels);
  const response =
    args.response && typeof args.response === 'object' && !Array.isArray(args.response)
      ? (args.response as Record<string, unknown>)
      : null;
  const lines: ReceiptLine[] = [
    { label: 'Submission', value: args.submissionId },
  ];
  const used = new Set<string>();
  if (response) {
    for (const [id, label] of labels) {
      if (!(id in response)) continue;
      used.add(id);
      lines.push({ label, value: formatValue(response[id]) });
    }
    for (const [key, value] of Object.entries(response)) {
      if (used.has(key) || key.startsWith('_')) continue;
      lines.push({ label: key, value: formatValue(value) });
    }
  }
  return {
    title: args.title.trim() || 'Form submission',
    capturedAt: args.capturedAt,
    lines,
  };
}

export function receiptFilename(title: string, submissionId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stem = slug || 'submission';
  const suffix = submissionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'receipt';
  return `${stem}-${suffix}.pdf`;
}

export function renderSubmissionPdf(receipt: SubmissionReceipt): Buffer {
  const rows: Drawn[] = [
    ...wrap(receipt.title, 42).map((text, i) => ({
      text,
      font: 'F1' as const,
      size: 16,
      leading: i === 0 ? 22 : 20,
    })),
    {
      text: `Submitted ${receipt.capturedAt}`,
      font: 'F2',
      size: 10,
      leading: 22,
    },
  ];
  for (const line of receipt.lines) {
    rows.push({
      text: line.label,
      font: 'F1',
      size: 11,
      leading: 18,
    });
    const value = line.value.trim() || '(blank)';
    for (const text of wrap(value, 90)) {
      rows.push({ text, font: 'F2', size: 10, leading: 14 });
    }
  }
  const pages = paginate(rows);
  return buildPdf(pages.map(paint));
}

function collectLabels(questions: unknown, into: Map<string, string>): void {
  if (!Array.isArray(questions)) return;
  for (const question of questions) {
    if (!question || typeof question !== 'object') continue;
    const rec = question as { id?: unknown; label?: unknown; children?: unknown };
    if (typeof rec.id === 'string' && typeof rec.label === 'string' && rec.label.trim()) {
      into.set(rec.id, rec.label.trim());
    }
    if (rec.children) collectLabels(rec.children, into);
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return clip(
      value
        .map((item) => formatValue(item))
        .filter((item) => item.length > 0)
        .join(', '),
    );
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.name === 'string' && typeof record.url === 'string') {
      return clip(record.name);
    }
    const coords = record.coordinates;
    if (
      Array.isArray(coords) &&
      coords.length >= 2 &&
      typeof coords[0] === 'number' &&
      typeof coords[1] === 'number'
    ) {
      return `${coords[1]}, ${coords[0]}`;
    }
    const lat = record.latitude ?? record.lat;
    const lon = record.longitude ?? record.lon ?? record.lng;
    if (typeof lat === 'number' && typeof lon === 'number') return `${lat}, ${lon}`;
    try {
      return clip(JSON.stringify(value));
    } catch {
      return '';
    }
  }
  return '';
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

function wrap(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < 12) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length > 0 ? out : [''];
}

function paginate(rows: Drawn[]): Drawn[][] {
  const pages: Drawn[][] = [];
  let page: Drawn[] = [];
  let y = TOP;
  for (const row of rows) {
    if (y - row.leading < BOTTOM && page.length > 0) {
      pages.push(page);
      page = [];
      y = TOP;
    }
    page.push(row);
    y -= row.leading;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

function paint(rows: Drawn[]): string {
  let y = TOP;
  const cmds = ['BT'];
  for (const row of rows) {
    y -= row.leading;
    cmds.push(`/${row.font} ${row.size} Tf`);
    cmds.push(`1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm`);
    cmds.push(`(${pdfText(row.text)}) Tj`);
  }
  cmds.push('ET');
  return cmds.join('\n');
}

/** WinAnsi-ish literal string. Bytes outside Latin-1 become "?". */
export function pdfText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\\' || ch === '(' || ch === ')') {
      out += `\\${ch}`;
    } else if (code >= 32 && code <= 126) {
      out += ch;
    } else if (code >= 160 && code <= 255) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
    } else if (ch === '\t') {
      out += ' ';
    } else {
      out += '?';
    }
  }
  return out;
}

function buildPdf(contents: string[]): Buffer {
  const objects: string[] = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = contents.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Count ${contents.length} /Kids [${kids}] >>\nendobj\n`,
  );
  objects.push(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
  );
  objects.push(
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  );
  contents.forEach((stream, i) => {
    const pageId = 5 + i * 2;
    const streamId = pageId + 1;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>\nendobj\n`,
    );
    objects.push(
      `${streamId} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  let offset = header.length;
  const offsets = [0];
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    offsets.push(offset);
    const buf = Buffer.from(obj, 'latin1');
    parts.push(buf);
    offset += buf.length;
  }
  let xref = `xref\n0 ${offsets.length}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
