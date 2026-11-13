// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The XLSX reader and writer: a round trip through our own writer,
 * and the shapes Excel and openpyxl write that the regex reader used
 * to misread.
 */
import { readXlsx, writeXlsx } from './xlsx';
import { zipStore } from './zip-store';

const enc = new TextEncoder();

/** A minimal workbook from raw parts, as another program wrote it. */
async function workbookFrom(parts: {
  workbook: string;
  rels: string;
  sheetPath: string;
  sheet: string;
  sharedStrings?: string;
}): Promise<Uint8Array> {
  const entries = [
    { name: 'xl/workbook.xml', data: enc.encode(parts.workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(parts.rels) },
    { name: parts.sheetPath, data: enc.encode(parts.sheet) },
  ];
  if (parts.sharedStrings) {
    entries.push({ name: 'xl/sharedStrings.xml', data: enc.encode(parts.sharedStrings) });
  }
  return zipStore(entries);
}

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WS_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

describe('readXlsx', () => {
  it('reads back what writeXlsx wrote (55-1)', async () => {
    const blob = await writeXlsx([
      { name: 'survey', rows: [['type', 'name', 'label'], ['text', 'q1', 'Question & one']] },
      { name: 'choices', rows: [['list_name', 'name'], ['yn', 'yes']] },
    ]);
    const book = await readXlsx(new Uint8Array(await blob.arrayBuffer()));
    expect(book.sheetNames).toEqual(['survey', 'choices']);
    expect(book.sheetToMatrix('survey')).toEqual([
      ['type', 'name', 'label'],
      ['text', 'q1', 'Question & one'],
    ]);
  });

  it('keeps cells in their columns past self-closing blank rows and cells (55-2)', async () => {
    const bytes = await workbookFrom({
      workbook: `<workbook xmlns="${MAIN_NS}" xmlns:r="${R_NS}"><sheets><sheet name="survey" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      rels: `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${WS_TYPE}" Target="worksheets/sheet1.xml"/></Relationships>`,
      sheetPath: 'xl/worksheets/sheet1.xml',
      sharedStrings:
        '<sst><si><t>type</t></si><si><t>name</t></si><si><t>label</t></si><si><t>text</t></si><si><t>q1</t></si></sst>',
      sheet:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2" ht="15"/>' +
        '<row r="3"><c r="A3" s="2"/><c r="B3" t="s"><v>4</v></c><c r="C3" t="s"><v>3</v></c></row>' +
        '</sheetData></worksheet>',
    });
    const book = await readXlsx(bytes);
    expect(book.sheetToMatrix('survey')).toEqual([
      ['type', 'name', 'label'],
      ['', '', ''],
      ['', 'q1', 'text'],
    ]);
  });

  it('opens a workbook written by openpyxl (absolute target, namespaced sheet tag)', async () => {
    const bytes = await workbookFrom({
      workbook: `<workbook xmlns="${MAIN_NS}"><sheets><sheet xmlns:r="${R_NS}" name="Sheet" sheetId="1" state="visible" r:id="rId1"/></sheets></workbook>`,
      rels: `<Relationships xmlns="${RELS_NS}"><Relationship Type="${WS_TYPE}" Target="/xl/worksheets/sheet1.xml" Id="rId1"/></Relationships>`,
      sheetPath: 'xl/worksheets/sheet1.xml',
      sheet:
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>',
    });
    const book = await readXlsx(bytes);
    expect(book.sheetNames).toEqual(['Sheet']);
    expect(book.sheetToMatrix('Sheet')).toEqual([['a', '2']]);
  });
});

describe('writeXlsx (55-7)', () => {
  it('leaves out characters XML does not allow, keeping tab and newline', async () => {
    const blob = await writeXlsx([
      { name: 'data', rows: [['a\u000Bb\u001Ac', 'line1\nline2\tx']] },
    ]);
    const book = await readXlsx(new Uint8Array(await blob.arrayBuffer()));
    expect(book.sheetToMatrix('data')).toEqual([['abc', 'line1\nline2\tx']]);
  });
});
