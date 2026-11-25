// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a data layer's fields look to an Esri client, and how stored
 * values become Esri attribute values. Two fields are added to every
 * layer: the ObjectID (from feature_oid) and the GlobalID (the
 * feature's own UUID).
 */

export type EsriFieldKind =
  | 'oid'
  | 'globalid'
  | 'string'
  | 'integer'
  | 'double'
  | 'date'
  | 'boolean'
  | 'multi';

export interface EsriField {
  /** The name Esri clients see and send back in where clauses. */
  name: string;
  /** The attribute key in the feature's stored properties. */
  attr: string | null;
  kind: EsriFieldKind;
  alias: string;
  nullable: boolean;
  domain: Record<string, unknown> | null;
  length?: number;
}

export interface EsriLayerSchema {
  oidField: string;
  globalIdField: string;
  /** ObjectID first, GlobalID second, then the layer's own fields. */
  fields: EsriField[];
  byLower: Map<string, EsriField>;
  displayField: string;
}

/** The subset of a stored field definition this file reads. */
export interface StoredField {
  name?: unknown;
  type?: unknown;
  label?: unknown;
  nullable?: unknown;
  domain?: unknown;
  storage?: unknown;
}

/** Esri's text type needs a length. Fields without a cap get this one. */
const DEFAULT_STRING_LENGTH = 1_073_741_822;

function uniqueName(wanted: string, taken: Set<string>): string {
  let name = wanted;
  for (let n = 1; taken.has(name.toLowerCase()); n++) name = `${wanted}_${n}`;
  taken.add(name.toLowerCase());
  return name;
}

function domainFor(fieldName: string, kind: EsriFieldKind, domain: unknown): Record<string, unknown> | null {
  if (kind === 'boolean') {
    return {
      type: 'codedValue',
      name: `${fieldName}_yes_no`,
      codedValues: [
        { name: 'False', code: 0 },
        { name: 'True', code: 1 },
      ],
    };
  }
  const d = domain as
    | { type?: unknown; values?: unknown; min?: unknown; max?: unknown }
    | null
    | undefined;
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'coded-value' && Array.isArray(d.values)) {
    const codedValues = (d.values as Array<{ code?: unknown; label?: unknown }>)
      .filter((v) => typeof v?.code === 'string' || typeof v?.code === 'number')
      .map((v) => ({
        name: typeof v.label === 'string' && v.label.length > 0 ? v.label : String(v.code),
        code: kind === 'integer' || kind === 'double' ? Number(v.code) : String(v.code),
      }))
      .filter((v) => typeof v.code !== 'number' || Number.isFinite(v.code));
    if (codedValues.length === 0) return null;
    return { type: 'codedValue', name: `${fieldName}_values`, codedValues };
  }
  if (d.type === 'range' && typeof d.min === 'number' && typeof d.max === 'number') {
    return { type: 'range', name: `${fieldName}_range`, range: [d.min, d.max] };
  }
  return null;
}

function kindOf(f: StoredField): EsriFieldKind {
  switch (f.type) {
    case 'number': {
      const storage = f.storage as { numberKind?: unknown } | undefined;
      return storage?.numberKind === 'integer' ? 'integer' : 'double';
    }
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'multi_select':
      return 'multi';
    default:
      return 'string';
  }
}

/** Build the Esri view of a layer's fields. */
export function esriSchema(storedFields: unknown): EsriLayerSchema {
  const list = Array.isArray(storedFields) ? (storedFields as StoredField[]) : [];
  const own = list.filter(
    (f): f is StoredField & { name: string } => typeof f?.name === 'string' && f.name.length > 0,
  );
  // The added fields keep their usual names unless the layer already
  // has a field called that, in any case.
  const taken = new Set(own.map((f) => f.name.toLowerCase()));
  const oidField = uniqueName('OBJECTID', taken);
  const globalIdField = uniqueName('GlobalID', taken);

  const fields: EsriField[] = [
    { name: oidField, attr: null, kind: 'oid', alias: 'OBJECTID', nullable: false, domain: null },
    {
      name: globalIdField,
      attr: null,
      kind: 'globalid',
      alias: 'GlobalID',
      nullable: false,
      domain: null,
      length: 38,
    },
  ];
  const seen = new Set<string>();
  for (const f of own) {
    if (seen.has(f.name.toLowerCase())) continue;
    seen.add(f.name.toLowerCase());
    const kind = kindOf(f);
    const storage = f.storage as { maxLength?: unknown } | undefined;
    const field: EsriField = {
      name: f.name,
      attr: f.name,
      kind,
      alias: typeof f.label === 'string' && f.label.trim().length > 0 ? f.label : f.name,
      nullable: f.nullable !== false,
      domain: domainFor(f.name, kind, f.domain),
    };
    if (kind === 'string' || kind === 'multi') {
      field.length =
        typeof storage?.maxLength === 'number' && storage.maxLength > 0
          ? storage.maxLength
          : DEFAULT_STRING_LENGTH;
    }
    fields.push(field);
  }
  const byLower = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const displayField = fields.find((f) => f.kind === 'string')?.name ?? oidField;
  return { oidField, globalIdField, fields, byLower, displayField };
}

const ESRI_TYPE: Record<EsriFieldKind, string> = {
  oid: 'esriFieldTypeOID',
  globalid: 'esriFieldTypeGlobalID',
  string: 'esriFieldTypeString',
  multi: 'esriFieldTypeString',
  integer: 'esriFieldTypeInteger',
  double: 'esriFieldTypeDouble',
  date: 'esriFieldTypeDate',
  boolean: 'esriFieldTypeSmallInteger',
};

const SQL_TYPE: Record<EsriFieldKind, string> = {
  oid: 'sqlTypeInteger',
  globalid: 'sqlTypeGUID',
  string: 'sqlTypeNVarchar',
  multi: 'sqlTypeNVarchar',
  integer: 'sqlTypeInteger',
  double: 'sqlTypeDouble',
  date: 'sqlTypeTimestamp2',
  boolean: 'sqlTypeSmallInt',
};

/** A field as it appears in a layer document or a query response. */
export function fieldDoc(f: EsriField, editable = false): Record<string, unknown> {
  return {
    name: f.name,
    type: ESRI_TYPE[f.kind],
    alias: f.alias,
    sqlType: SQL_TYPE[f.kind],
    ...(f.length !== undefined ? { length: f.length } : {}),
    ...(f.kind === 'date' ? { length: 8 } : {}),
    nullable: f.nullable,
    // Editable only for a caller who may edit the layer; the ObjectID
    // and GlobalID are the server's.
    editable: editable && f.kind !== 'oid' && f.kind !== 'globalid',
    domain: f.domain,
    defaultValue: null,
  };
}

/** `{B6E0...}`, the way Esri writes a GlobalID. */
export function toGlobalId(entity: string): string {
  return `{${entity.toUpperCase()}}`;
}

/** A GlobalID as Esri sends it (with or without braces) to a UUID. */
export function fromGlobalId(value: string): string | null {
  const v = value.trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
}

/** A stored attribute value as an Esri attribute value. */
export function esriValue(kind: EsriFieldKind, raw: unknown): string | number | null {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case 'integer':
    case 'double': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      if (raw === true || raw === 'true' || raw === 1) return 1;
      if (raw === false || raw === 'false' || raw === 0) return 0;
      return null;
    case 'date': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
      if (typeof raw !== 'string') return null;
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms : null;
    }
    case 'multi':
      if (Array.isArray(raw)) return raw.map((v) => String(v)).join(', ');
      return String(raw);
    default:
      if (typeof raw === 'object') return JSON.stringify(raw);
      return String(raw);
  }
}
