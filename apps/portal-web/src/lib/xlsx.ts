// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal XLSX reader + writer (#51). Replaces the SheetJS
 * (xlsx) dependency with a vendored, dependency-free
 * implementation of the subset of OOXML we actually need:
 *
 *   - Multi-sheet workbooks with 2D-array values per sheet
 *   - String + number cells (booleans / dates are stringified)
 *   - Inline strings (no shared-strings table) so writes stay
 *     simple; reads honour both inline + sharedStrings
 *   - Plain values, no formulas, no merged cells, no styles
 *
 * Not implemented (intentionally):
 *   - Cell formatting (number formats, colors, borders, fonts)
 *   - Merged cells, frozen rows, autofilters, charts
 *   - Formulas (we read them as the cached value if present;
 *     we never write any)
 *   - Defined names, comments, pivot tables
 *
 * The use cases this serves are: data export (bundle-export /
 * layer-export, sheets that the user opens in Excel and reads
 * raw values), XLSForm import (form designer reads a survey
 * sheet's rows as plain values), pick-list import (editor
 * reads a 2D string matrix). None of those use any of the
 * features above.
 */

import { ZipReader } from './zip-reader';
import { ZipWriter } from './zip-writer';

// ====================================================================
// Reader
// ====================================================================

export interface XlsxWorkbookReader {
  /** Sheet names in workbook order. */
  sheetNames: string[];
  /** Read one sheet as a 2D array of cell values. Empty cells
   *  come back as `''` so the row stays the same width across
   *  every row in the sheet. */
  sheetToMatrix(name: string): string[][];
  /** Read one sheet as an array of row objects keyed by the
   *  first-row header. Strict mode about column types: every
   *  value comes back as a string (or empty string for blanks);
   *  callers that need numbers can `Number()` per-field. */
  sheetToObjects(name: string): Record<string, string>[];
}

/** Open an XLSX workbook from a Blob / ArrayBuffer / Uint8Array. */
export async function readXlsx(
  source: Blob | ArrayBuffer | Uint8Array,
): Promise<XlsxWorkbookReader> {
  const zip = await ZipReader.open(source);

  // workbook.xml lists the sheets in order. Each <sheet> has a
  // name + an r:id that resolves to a sheet xml part via the
  // workbook's _rels file.
  const workbookXml = await zip.readText('xl/workbook.xml');
  const relsXml = await zip.readText('xl/_rels/workbook.xml.rels');
  const sheets = parseSheets(workbookXml, relsXml);

  // sharedStrings.xml is optional (only present if any cell
  // uses a shared-string reference). When absent, the workbook
  // is entirely inline-string + number cells.
  let sharedStrings: string[] = [];
  if (zip.has('xl/sharedStrings.xml')) {
    sharedStrings = parseSharedStrings(
      await zip.readText('xl/sharedStrings.xml'),
    );
  }

  const matrixCache = new Map<string, string[][]>();

  async function loadMatrix(name: string): Promise<string[][]> {
    if (matrixCache.has(name)) return matrixCache.get(name)!;
    const sheet = sheets.find((s) => s.name === name);
    if (!sheet) throw new Error(`Sheet not found: ${name}`);
    const sheetXml = await zip.readText(sheetPartPath(sheet.target));
    const matrix = parseSheetMatrix(sheetXml, sharedStrings);
    matrixCache.set(name, matrix);
    return matrix;
  }

  // Pre-load every sheet so the sync reader API can return
  // results without await. XLSX workbooks in the wild are small
  // enough that this is fine; we already paid the ZIP-inflate
  // cost on open.
  for (const s of sheets) {
    await loadMatrix(s.name);
  }

  return {
    sheetNames: sheets.map((s) => s.name),
    sheetToMatrix(name: string): string[][] {
      const m = matrixCache.get(name);
      if (!m) throw new Error(`Sheet not found: ${name}`);
      return m.map((row) => [...row]);
    },
    sheetToObjects(name: string): Record<string, string>[] {
      const m = matrixCache.get(name);
      if (!m) throw new Error(`Sheet not found: ${name}`);
      if (m.length === 0) return [];
      const headers = m[0]!;
      const rows: Record<string, string>[] = [];
      for (let r = 1; r < m.length; r += 1) {
        const row = m[r]!;
        const obj: Record<string, string> = {};
        for (let c = 0; c < headers.length; c += 1) {
          const h = headers[c];
          if (!h) continue;
          obj[h] = row[c] ?? '';
        }
        rows.push(obj);
      }
      return rows;
    },
  };
}

interface SheetRef {
  name: string;
  rid: string;
  /** Path relative to xl/. E.g. "worksheets/sheet1.xml". */
  target: string;
}

function parseSheets(workbookXml: string, relsXml: string): SheetRef[] {
  // <sheet name="X" sheetId="1" r:id="rId1"/>. The attribute text may
  // hold a `/` (openpyxl puts a namespace URL on the tag), so only `>`
  // ends it.
  const sheetMatches = Array.from(
    workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/g),
  );
  const sheets: SheetRef[] = [];
  for (const m of sheetMatches) {
    const attrs = parseAttrs(m[1] ?? '');
    const name = attrs.get('name');
    const rid = attrs.get('r:id');
    if (!name || !rid) continue;
    sheets.push({ name, rid, target: '' });
  }
  // <Relationship Id="rId1" Target="worksheets/sheet1.xml" .../>.
  // Type and Target are paths and URLs, so `/` inside the tag is normal.
  const relMatches = Array.from(
    relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g),
  );
  const targetByRid = new Map<string, string>();
  for (const m of relMatches) {
    const attrs = parseAttrs(m[1] ?? '');
    const id = attrs.get('Id');
    const target = attrs.get('Target');
    if (id && target) targetByRid.set(id, target);
  }
  for (const s of sheets) {
    s.target = targetByRid.get(s.rid) ?? '';
  }
  return sheets.filter((s) => s.target);
}

/** Zip path of a worksheet. A relationship target is relative to xl/,
 *  except that openpyxl (so pandas) writes it from the archive root,
 *  starting with `/`. */
function sheetPartPath(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

function parseAttrs(input: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(\w+(?::\w+)?)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.set(m[1] as string, m[2] as string);
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  // <si><t>value</t></si> with optional <r> rich-text runs that
  // we flatten by concatenating every <t> inside the <si>. We
  // honour `xml:space="preserve"` implicitly because we never
  // trim the captured text.
  const result: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    result.push(extractAllText(m[1] ?? ''));
  }
  return result;
}

function extractAllText(siInner: string): string {
  let out = '';
  const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(siInner)) !== null) {
    out += decodeXmlEntities(tm[1] ?? '');
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&');
}

// Characters XML 1.0 does not allow at all, escaped or not: C0 controls
// other than tab, LF and CR, and the two non-characters U+FFFE/U+FFFF.
// One of them in a cell (stray 0x0B from a legacy DBF, pasted text) and
// Excel refuses the whole workbook.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function encodeXmlText(s: string): string {
  return s
    .replace(XML_ILLEGAL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseSheetMatrix(
  sheetXml: string,
  sharedStrings: string[],
): string[][] {
  // Find each <row r="N"> ... </row>. We don't trust the row
  // number for ordering (sparse rows are legal); we just walk
  // them in document order.
  // An empty row can be written self-closing (`<row r="2" ht="15"/>`),
  // so that form is matched first: as an opening tag it would swallow
  // the next row up to its `</row>`.
  const rowRe = /<row\b[^>]*?\/>|<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const out: string[][] = [];
  let rm: RegExpExecArray | null;
  let maxCols = 0;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells: string[] = [];
    // Each cell looks like <c r="A1" t="s"><v>4</v></c> or
    // <c r="B1"><v>123.45</v></c> or
    // <c r="C1" t="inlineStr"><is><t>foo</t></is></c>
    // Self-closing first, for the same reason as rows: Excel writes
    // `<c r="A3" s="2"/>` for every formatted blank cell, and read as
    // an opening tag it took the next cell's value into its column.
    const cellRe =
      /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1] ?? '')) !== null) {
      const attrText = cm[1] ?? cm[2] ?? '';
      const inner = cm[3] ?? '';
      const attrs = parseAttrs(attrText);
      const ref = attrs.get('r') ?? '';
      const type = attrs.get('t') ?? 'n';
      const col = colIndexFromRef(ref);
      // Resolve the cell's value based on its declared type.
      let value = '';
      if (type === 's') {
        // Shared-string reference.
        const idxMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (idxMatch) {
          const idx = parseInt(idxMatch[1] ?? '', 10);
          value = sharedStrings[idx] ?? '';
        }
      } else if (type === 'inlineStr') {
        value = extractAllText(inner);
      } else if (type === 'str') {
        // Formula result that resolved to a string.
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXmlEntities(v[1] ?? '') : '';
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        // Number (default), date stored as number, etc.
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXmlEntities(v[1] ?? '') : '';
      }
      while (cells.length <= col) cells.push('');
      cells[col] = value;
    }
    out.push(cells);
    if (cells.length > maxCols) maxCols = cells.length;
  }
  // Pad every row to the widest row so the matrix is
  // rectangular -- callers can iterate with a fixed column
  // count without bounds checking.
  for (const row of out) {
    while (row.length < maxCols) row.push('');
  }
  return out;
}

/** Convert a cell ref like "AB12" into a 0-based column index. */
function colIndexFromRef(ref: string): number {
  let col = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const ch = ref.charCodeAt(i);
    if (ch < 65 || ch > 90) break; // not A-Z
    col = col * 26 + (ch - 64);
  }
  return col - 1;
}

// ====================================================================
// Writer
// ====================================================================

export interface XlsxSheet {
  name: string;
  /** 2D array of cell values. Row 0 is the header row by
   *  convention but the writer doesn't care -- every row is
   *  rendered identically. */
  rows: Array<Array<string | number | boolean | null | undefined>>;
}

/** Build a workbook as a Blob from one or more sheets. */
export async function writeXlsx(sheets: XlsxSheet[]): Promise<Blob> {
  const zip = new ZipWriter();

  // [Content_Types].xml — declares the MIME type for each part.
  await zip.file('[Content_Types].xml', contentTypesXml(sheets.length));
  // _rels/.rels — root relationships, points at xl/workbook.xml.
  await zip.file('_rels/.rels', rootRelsXml());
  // xl/_rels/workbook.xml.rels — workbook's per-sheet rels.
  await zip.file('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets.length));
  // xl/workbook.xml — the sheet list.
  await zip.file('xl/workbook.xml', workbookXml(sheets));
  // xl/styles.xml — minimal styles part. Excel refuses to open
  // the workbook without one even if no cell uses any style.
  await zip.file('xl/styles.xml', stylesXml());
  // xl/worksheets/sheetN.xml — one part per sheet.
  for (let i = 0; i < sheets.length; i += 1) {
    await zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      sheetXml(sheets[i]!.rows),
    );
  }
  return zip.blob();
}

function contentTypesXml(sheetCount: number): string {
  const sheetParts = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheetParts +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`
  );
}

function rootRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
    `Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  const stylesRel =
    `<Relationship Id="rId${sheetCount + 1}" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` +
    `Target="styles.xml"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheetRels +
    stylesRel +
    `</Relationships>`
  );
}

function workbookXml(sheets: XlsxSheet[]): string {
  const sheetEntries = sheets
    .map(
      (s, i) =>
        `<sheet name="${encodeXmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetEntries}</sheets>` +
    `</workbook>`
  );
}

function stylesXml(): string {
  // Minimal styles part: one default font, fill, border,
  // cell-format, and named-style. Excel refuses to open the
  // file if any of these arrays are empty.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

function sheetXml(
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>`,
  );
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    parts.push(`<row r="${r + 1}">`);
    for (let c = 0; c < row.length; c += 1) {
      const value = row[c];
      if (value === null || value === undefined || value === '') continue;
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) {
        parts.push(`<c r="${ref}"><v>${value}</v></c>`);
      } else if (typeof value === 'boolean') {
        parts.push(
          `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`,
        );
      } else {
        // Inline string: avoids a sharedStrings.xml table and
        // keeps the writer streaming-friendly. Excel handles
        // inline strings as a first-class cell type.
        parts.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlText(
            String(value),
          )}</t></is></c>`,
        );
      }
    }
    parts.push(`</row>`);
  }
  parts.push(`</sheetData></worksheet>`);
  return parts.join('');
}

function colLetter(col: number): string {
  // 0 -> "A", 25 -> "Z", 26 -> "AA"
  let n = col;
  let out = '';
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}
