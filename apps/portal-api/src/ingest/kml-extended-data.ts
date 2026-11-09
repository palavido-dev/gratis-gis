// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * KML attributes beyond Name and Description (#573).
 *
 * GDAL's KML driver, the one in the bundled GDAL we ship, reads each
 * Placemark's name, description and geometry but ignores
 * `<ExtendedData>`. A KMZ exported from Google Earth, ArcGIS or QGIS
 * keeps its real attributes there, so imports came in with two
 * fields. LIBKML reads them, but it is not in our GDAL build. This
 * module reads ExtendedData itself and hands each GDAL layer the
 * extra columns, matched feature by feature.
 *
 * How the KML driver lays out layers (checked against GDAL, see the
 * spec): every Document or Folder with at least one Placemark that has
 * geometry becomes a layer, emitted when the container closes, so
 * nested folders come out before their parent. Placemarks with no
 * geometry element are dropped. Features keep document order.
 *
 * The match is checked, never assumed: a layer gets extra columns only
 * when its placemark count and every placemark name agree with what
 * GDAL returned. Anything else keeps today's behavior (Name and
 * Description only) rather than put a value on the wrong feature.
 *
 * Parsing uses the vendored walker in admin/xml-walker.ts, which skips
 * DOCTYPE, never expands custom entities and never fetches anything,
 * so a hostile upload cannot reach the network or blow up memory
 * through entity expansion.
 */
import { parseXml, type XmlElement, type XmlValue } from '../admin/xml-walker.js';

export type KmlFieldType = 'string' | 'number' | 'boolean';

export interface KmlExtendedLayer {
  /** The container's <name>, or null when it has none. */
  name: string | null;
  /** Extra columns in first-seen order. */
  fields: Array<{ name: string; type: KmlFieldType }>;
  /** One row per kept placemark, in document order. */
  rows: Array<{ name: string | null; values: Record<string, unknown> }>;
}

/** Elements the KML driver turns into a geometry. */
const GEOMETRY_TAGS = ['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry'];
const CONTAINER_TAGS = ['Document', 'Folder'];

function asArray(v: XmlValue | undefined): XmlValue[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function asElement(v: XmlValue | undefined): XmlElement | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as XmlElement) : null;
}

/** Text content of a leaf, whether the walker gave a string or {#text}. */
function textOf(v: XmlValue | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const el = asElement(v);
  if (el) {
    const t = el['#text'];
    return t === undefined ? '' : String(t);
  }
  return null;
}

function attr(el: XmlElement, name: string): string | null {
  const v = el[`@_${name}`];
  return typeof v === 'string' ? v : null;
}

function fieldTypeOf(kmlType: string | null): KmlFieldType {
  switch ((kmlType ?? '').toLowerCase()) {
    case 'int':
    case 'uint':
    case 'short':
    case 'ushort':
    case 'float':
    case 'double':
      return 'number';
    case 'bool':
      return 'boolean';
    default:
      return 'string';
  }
}

function coerce(raw: string | null, type: KmlFieldType): unknown {
  if (raw === null) return null;
  if (type === 'string') return raw;
  const t = raw.trim();
  if (t === '') return null;
  if (type === 'number') {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const b = t.toLowerCase();
  if (b === '1' || b === 'true') return true;
  if (b === '0' || b === 'false') return false;
  return null;
}

/** Schema id and name -> field types, from every <Schema> in the file. */
function collectSchemas(root: XmlElement): Map<string, Map<string, KmlFieldType>> {
  const out = new Map<string, Map<string, KmlFieldType>>();
  const visit = (el: XmlElement): void => {
    for (const s of asArray(el['Schema'])) {
      const schema = asElement(s);
      if (!schema) continue;
      const types = new Map<string, KmlFieldType>();
      for (const f of asArray(schema['SimpleField'])) {
        const field = asElement(f);
        const fname = field ? attr(field, 'name') : null;
        if (field && fname) types.set(fname, fieldTypeOf(attr(field, 'type')));
      }
      const id = attr(schema, 'id');
      const name = attr(schema, 'name');
      if (id) out.set(id, types);
      if (name && !out.has(name)) out.set(name, types);
    }
    for (const tag of CONTAINER_TAGS) {
      for (const c of asArray(el[tag])) {
        const child = asElement(c);
        if (child) visit(child);
      }
    }
  };
  visit(root);
  return out;
}

function hasGeometry(placemark: XmlElement): boolean {
  return GEOMETRY_TAGS.some((t) => placemark[t] !== undefined);
}

/**
 * Parse a KML document into the layers GDAL's KML driver will report,
 * in the same order, with each kept placemark's ExtendedData. Returns
 * an empty list when the document has no ExtendedData at all, so the
 * common case costs one parse and nothing else. Throws only on XML
 * the walker cannot read.
 */
export function parseKmlExtendedData(xml: string): KmlExtendedLayer[] {
  const doc = parseXml(xml);
  const kml = asElement(doc['kml']);
  if (!kml) return [];
  const schemas = collectSchemas(kml);
  const layers: KmlExtendedLayer[] = [];
  let sawExtended = false;

  const buildLayer = (name: string | null, placemarks: XmlValue[]): void => {
    const fieldOrder = new Map<string, KmlFieldType>();
    const rows: KmlExtendedLayer['rows'] = [];
    for (const p of placemarks) {
      const pm = asElement(p);
      if (!pm || !hasGeometry(pm)) continue;
      const values: Record<string, unknown> = {};
      const ext = asElement(pm['ExtendedData']);
      if (ext) {
        for (const d of asArray(ext['Data'])) {
          const data = asElement(d);
          const key = data ? attr(data, 'name') : null;
          if (!data || !key) continue;
          sawExtended = true;
          if (!fieldOrder.has(key)) fieldOrder.set(key, 'string');
          values[key] = textOf(data['value']) ?? null;
        }
        for (const sd of asArray(ext['SchemaData'])) {
          const schemaData = asElement(sd);
          if (!schemaData) continue;
          const url = attr(schemaData, 'schemaUrl') ?? '';
          const types = schemas.get(url.startsWith('#') ? url.slice(1) : url);
          for (const s of asArray(schemaData['SimpleData'])) {
            const simple = asElement(s);
            const key = simple ? attr(simple, 'name') : null;
            if (!simple || !key) continue;
            sawExtended = true;
            const type = types?.get(key) ?? 'string';
            if (!fieldOrder.has(key)) fieldOrder.set(key, type);
            values[key] = coerce(textOf(simple), fieldOrder.get(key) ?? type);
          }
        }
      }
      rows.push({ name: textOf(pm['name']), values });
    }
    if (rows.length === 0) return;
    layers.push({
      name,
      fields: [...fieldOrder].map(([fname, type]) => ({ name: fname, type })),
      rows,
    });
  };

  // Post-order: child containers first, then the container's own
  // placemarks, which is when GDAL emits the layer.
  const walk = (el: XmlElement): void => {
    for (const tag of CONTAINER_TAGS) {
      for (const c of asArray(el[tag])) {
        const child = asElement(c);
        if (child) walk(child);
      }
    }
    buildLayer(textOf(el['name']), asArray(el['Placemark']));
  };
  // A bare <kml><Placemark/></kml> is one unnamed layer.
  for (const tag of CONTAINER_TAGS) {
    for (const c of asArray(kml[tag])) {
      const child = asElement(c);
      if (child) walk(child);
    }
  }
  buildLayer(null, asArray(kml['Placemark']));

  return sawExtended ? layers : [];
}

/**
 * True when `layer` lines up with what GDAL returned for one layer:
 * the same number of features and the same Name on each, in order.
 * GDAL reports a missing name as an empty string.
 */
export function kmlLayerMatches(
  layer: KmlExtendedLayer,
  gdalNames: ReadonlyArray<string | null>,
): boolean {
  if (layer.rows.length !== gdalNames.length) return false;
  for (let i = 0; i < gdalNames.length; i += 1) {
    const ours = (layer.rows[i]!.name ?? '').trim();
    const theirs = (gdalNames[i] ?? '').trim();
    if (ours !== theirs) return false;
  }
  return true;
}

/**
 * Extra KML columns for GDAL layer `index`, or null when there are
 * none or the layer does not line up with what we parsed. Reads the
 * layer's Name column once to check the match; the caller's own walk
 * restarts the cursor afterwards. Columns GDAL already has (Name,
 * Description) are left to GDAL.
 */
export function kmlAugmentFor(
  ext: readonly KmlExtendedLayer[],
  index: number,
  layer: {
    fields: { count(): number; get(i: number): { name: string } };
    features: { forEach(cb: (f: { fields: { get(n: string): unknown } }) => void): void };
  },
): {
  fields: KmlExtendedLayer['fields'];
  valuesAt(i: number): Record<string, unknown>;
} | null {
  const parsed = ext[index];
  if (!parsed || parsed.fields.length === 0) return null;
  const names: Array<string | null> = [];
  layer.features.forEach((f) => {
    const n = f.fields.get('Name');
    names.push(typeof n === 'string' ? n : null);
  });
  if (!kmlLayerMatches(parsed, names)) return null;
  const taken = new Set<string>();
  for (let i = 0; i < layer.fields.count(); i += 1) {
    taken.add(layer.fields.get(i).name.toLowerCase());
  }
  const fields = parsed.fields.filter((f) => !taken.has(f.name.toLowerCase()));
  if (fields.length === 0) return null;
  const keep = new Set(fields.map((f) => f.name));
  return {
    fields,
    valuesAt(i) {
      const row = parsed.rows[i];
      const out: Record<string, unknown> = {};
      for (const f of fields) out[f.name] = null;
      if (!row) return out;
      for (const [k, v] of Object.entries(row.values)) if (keep.has(k)) out[k] = v;
      return out;
    },
  };
}
