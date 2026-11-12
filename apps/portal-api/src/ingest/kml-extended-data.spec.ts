// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { IngestService } from './ingest.service.js';
import { kmlAugmentFor, kmlLayerMatches, parseKmlExtendedData } from './kml-extended-data.js';

/**
 * Nested folders, a placemark without geometry, typed SchemaData,
 * untyped Data, accented text, and a duplicate folder name. GDAL's KML
 * driver reports these layers, in this order: F1a, F1, "F1 (#2)", Doc.
 */
const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Doc</name>
<Schema name="setor" id="setor">
  <SimpleField name="Bairro" type="string"/>
  <SimpleField name="Area" type="double"/>
  <SimpleField name="Ativo" type="bool"/>
</Schema>
<Placemark><name>D1</name><ExtendedData><Data name="Codigo"><value>d1</value></Data></ExtendedData><Point><coordinates>1,2</coordinates></Point></Placemark>
<Folder><name>F1</name>
  <Placemark><name>A</name><ExtendedData><SchemaData schemaUrl="#setor">
    <SimpleData name="Bairro">São José</SimpleData><SimpleData name="Area">12.5</SimpleData><SimpleData name="Ativo">1</SimpleData>
  </SchemaData></ExtendedData><Point><coordinates>1,2</coordinates></Point></Placemark>
  <Placemark><name>SemForma</name><ExtendedData><Data name="Codigo"><value>x</value></Data></ExtendedData></Placemark>
  <Folder><name>F1a</name>
    <Placemark><name>Nested</name><ExtendedData><Data name="Codigo"><value>n</value></Data></ExtendedData><LineString><coordinates>1,2 3,4</coordinates></LineString></Placemark>
  </Folder>
  <Placemark><name>B</name><ExtendedData><SchemaData schemaUrl="#setor">
    <SimpleData name="Bairro">Praça</SimpleData><SimpleData name="Area">bad</SimpleData>
  </SchemaData></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
<Folder><name>F1</name><Placemark><name>Dup</name><Point><coordinates>5,5</coordinates></Point></Placemark></Folder>
</Document></kml>`;

/** Minimal stored (or deflated) zip writer, enough for a one-file KMZ. */
function zipOne(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const body = deflateRawSync(data);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const localLen = local.length + nameBuf.length + body.length;
  const centralLen = central.length + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralLen, 12);
  eocd.writeUInt32LE(localLen, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

describe('parseKmlExtendedData', () => {
  it('reports layers in the order GDAL emits them, without geometry-less placemarks', () => {
    const layers = parseKmlExtendedData(KML);
    expect(layers.map((l) => l.name)).toEqual(['F1a', 'F1', 'F1', 'Doc']);
    expect(layers.map((l) => l.rows.map((r) => r.name))).toEqual([
      ['Nested'],
      ['A', 'B'],
      ['Dup'],
      ['D1'],
    ]);
  });

  it('types SchemaData fields from the Schema and leaves Data as text', () => {
    const f1 = parseKmlExtendedData(KML)[1]!;
    expect(f1.fields).toEqual([
      { name: 'Bairro', type: 'string' },
      { name: 'Area', type: 'number' },
      { name: 'Ativo', type: 'boolean' },
    ]);
    expect(f1.rows[0]!.values).toEqual({ Bairro: 'São José', Area: 12.5, Ativo: true });
    // An unreadable number becomes null rather than failing the row.
    expect(f1.rows[1]!.values).toEqual({ Bairro: 'Praça', Area: null });
  });

  it('returns nothing for KML without ExtendedData', () => {
    expect(
      parseKmlExtendedData(
        '<kml><Document><Placemark><name>a</name><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>',
      ),
    ).toEqual([]);
  });

  it('handles a bare Placemark root', () => {
    const layers = parseKmlExtendedData(
      '<kml><Placemark><name>Solo</name><ExtendedData><Data name="k"><value>s</value></Data></ExtendedData><Point><coordinates>1,2</coordinates></Point></Placemark></kml>',
    );
    expect(layers).toEqual([
      { name: null, fields: [{ name: 'k', type: 'string' }], rows: [{ name: 'Solo', values: { k: 's' } }] },
    ]);
  });

  it('does not expand entities declared in a DOCTYPE', () => {
    const layers = parseKmlExtendedData(
      '<!DOCTYPE kml [<!ENTITY big "xxxxxxxx">]><kml><Placemark><name>a</name><ExtendedData><Data name="k"><value>&big;</value></Data></ExtendedData><Point><coordinates>1,2</coordinates></Point></Placemark></kml>',
    );
    expect(layers[0]!.rows[0]!.values).toEqual({ k: '&big;' });
  });
});

describe('kmlLayerMatches', () => {
  const layer = parseKmlExtendedData(KML)[1]!;

  it('accepts the same count and names', () => {
    expect(kmlLayerMatches(layer, ['A', 'B'])).toBe(true);
  });

  it('refuses a different count or a different name', () => {
    expect(kmlLayerMatches(layer, ['A'])).toBe(false);
    expect(kmlLayerMatches(layer, ['A', 'C'])).toBe(false);
  });
});

/** A stand-in for a gdal-async layer: field names and feature Names. */
function fakeLayer(fieldNames: string[], featureNames: string[]) {
  return {
    fields: { count: () => fieldNames.length, get: (i: number) => ({ name: fieldNames[i]! }) },
    features: {
      forEach(cb: (f: { fields: { get(n: string): unknown } }) => void) {
        for (const n of featureNames) cb({ fields: { get: () => n } });
      },
    },
  };
}

describe('kmlAugmentFor', () => {
  const ext = parseKmlExtendedData(KML);

  it('attaches the columns when the layer lines up', () => {
    const aug = kmlAugmentFor(ext, 1, fakeLayer(['Name', 'Description'], ['A', 'B']));
    expect(aug?.fields.map((f) => f.name)).toEqual(['Bairro', 'Area', 'Ativo']);
    expect(aug?.valuesAt(1)).toEqual({ Bairro: 'Praça', Area: null, Ativo: null });
  });

  it('attaches nothing when GDAL saw different placemarks', () => {
    expect(kmlAugmentFor(ext, 1, fakeLayer(['Name', 'Description'], ['A']))).toBeNull();
    expect(kmlAugmentFor(ext, 1, fakeLayer(['Name', 'Description'], ['B', 'A']))).toBeNull();
    expect(kmlAugmentFor(ext, 9, fakeLayer(['Name', 'Description'], ['A', 'B']))).toBeNull();
  });

  it('leaves columns GDAL already has to GDAL', () => {
    const aug = kmlAugmentFor(ext, 1, fakeLayer(['Name', 'Description', 'bairro'], ['A', 'B']));
    expect(aug?.fields.map((f) => f.name)).toEqual(['Area', 'Ativo']);
  });
});

/** End to end through GDAL's KML driver. */
describe('IngestService KML ExtendedData', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-kml-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds the ExtendedData columns to a .kml layer', async () => {
    const path = join(dir, 'setores.kml');
    await writeFile(path, KML);
    const ingest = new IngestService();
    const probe = await ingest.probeFileFromPath(path);
    const f1 = probe.layers.find((l) => l.name === 'F1')!;
    expect(f1.fields.map((f) => [f.name, f.type])).toEqual([
      ['Name', 'string'],
      ['Description', 'string'],
      ['Bairro', 'string'],
      ['Area', 'number'],
      ['Ativo', 'boolean'],
    ]);
    const props: Array<Record<string, unknown>> = [];
    await ingest.streamLayerFromPath(path, 'F1', async (batch) => {
      for (const f of batch) props.push(f.properties);
    });
    expect(props).toEqual([
      { Name: 'A', Description: '', Bairro: 'São José', Area: 12.5, Ativo: true },
      { Name: 'B', Description: '', Bairro: 'Praça', Area: null, Ativo: null },
    ]);
  });

  it('reads the KML inside a .kmz and streams the extra columns', async () => {
    const path = join(dir, 'setores.kmz');
    await writeFile(path, zipOne('doc.kml', Buffer.from(KML, 'utf8')));
    const ingest = new IngestService();
    const rows: Array<Record<string, unknown>> = [];
    await ingest.streamLayerFromPath(path, 'F1a', async (batch) => {
      for (const r of batch) rows.push(r.properties);
    });
    expect(rows).toEqual([{ Name: 'Nested', Description: '', Codigo: 'n' }]);
  });

});
