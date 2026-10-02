// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only item facts a draft prompt is allowed to carry: type,
 * title, description, layer titles, and field names (plus the
 * field's own label and type). Geometries, drawings, feature
 * properties, filter values, and domain code lists are not read.
 */

const MAX_FIELDS = 80;
const MAX_LAYERS = 40;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 4000;

export interface ContextField {
  name: string;
  label: string | null;
  type: string | null;
}

export interface ContextLayer {
  title: string;
  fields: ContextField[];
}

export interface ItemPromptSource {
  type: string;
  title: string;
  description: string | null;
  data: unknown;
}

export interface ItemPromptContext {
  type: string;
  title: string;
  description: string;
  fields: ContextField[];
  layers: ContextLayer[];
}

export interface ChatPrompt {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  'You draft suggestions for one GIS item the user can already read.',
  'You cannot change the item. Reply with one JSON object and no markdown.',
  'Use only the field and layer names in the item context. Do not invent columns that are not listed.',
  'Shape:',
  '{',
  '  "summary": string,',
  '  "mapFilter": null | { "layerTitle": string, "filter": { "combinator": "all" | "any", "clauses": [{ "field": string, "op": "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "is-null" | "is-not-null", "value": string }] } },',
  '  "layerSummary": null | { "title": string, "bullets": string[] },',
  '  "formFields": [{ "name": string, "label": string, "type": "string" | "number" | "boolean" | "date" | "multi_select" }]',
  '}',
  'summary is required. Leave mapFilter and layerSummary null, and formFields empty, when the instruction does not ask for them.',
].join('\n');

export function extractItemContext(item: ItemPromptSource): ItemPromptContext {
  const fields: ContextField[] = [];
  const layers: ContextLayer[] = [];
  const data = item.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const root = data as Record<string, unknown>;
    collectFieldArray(root.fields, fields);
    if (Array.isArray(root.layers)) {
      for (const layer of root.layers) {
        if (layers.length >= MAX_LAYERS) break;
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
        const rec = layer as Record<string, unknown>;
        const title =
          clip(rec.title, 200) ??
          clip(rec.label, 200) ??
          clip(rec.name, 200) ??
          'Layer';
        const layerFields: ContextField[] = [];
        collectFieldArray(rec.fields, layerFields);
        collectFilterFieldNames(rec.filter, layerFields);
        collectTimeField(rec.timeFilter, layerFields);
        layers.push({ title, fields: layerFields });
      }
    }
    if (Array.isArray(root.questions)) {
      collectQuestions(root.questions, fields, 0);
    }
  }
  return {
    type: clip(item.type, 80) ?? 'item',
    title: clip(item.title, MAX_TITLE) ?? 'Untitled',
    description: clip(item.description, MAX_DESCRIPTION) ?? '',
    fields: fields.slice(0, MAX_FIELDS),
    layers,
  };
}

export function renderItemPrompt(
  context: ItemPromptContext,
  instruction: string,
): ChatPrompt {
  const lines: string[] = [
    'Instruction:',
    instruction.trim(),
    '',
    'Item:',
    `type: ${context.type}`,
    `title: ${context.title}`,
  ];
  if (context.description) {
    lines.push(`description: ${context.description}`);
  }
  if (context.layers.length > 0) {
    lines.push('', 'Layers:');
    for (const layer of context.layers) {
      const names = layer.fields.map((field) => field.name);
      lines.push(
        names.length > 0
          ? `- ${layer.title} (fields: ${names.join(', ')})`
          : `- ${layer.title}`,
      );
    }
  }
  if (context.fields.length > 0) {
    lines.push('', 'Fields:');
    for (const field of context.fields) {
      const bits = [field.name];
      if (field.type) bits.push(`(${field.type})`);
      if (field.label && field.label !== field.name) bits.push(field.label);
      lines.push(`- ${bits.join(' ')}`);
    }
  }
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

function collectFieldArray(raw: unknown, out: ContextField[]): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    pushField(out, entry);
  }
}

function pushField(out: ContextField[], raw: unknown): void {
  if (out.length >= MAX_FIELDS) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const rec = raw as Record<string, unknown>;
  const name = clip(rec.name, 80);
  if (!name) return;
  if (out.some((field) => field.name === name)) return;
  out.push({
    name,
    label: clip(rec.label, 120),
    type: clip(rec.type, 40),
  });
}

function collectFilterFieldNames(raw: unknown, out: ContextField[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const clauses = (raw as { clauses?: unknown }).clauses;
  if (!Array.isArray(clauses)) return;
  for (const clause of clauses) {
    if (!clause || typeof clause !== 'object') continue;
    const name = clip((clause as { field?: unknown }).field, 80);
    if (!name) continue;
    pushField(out, { name });
  }
}

function collectTimeField(raw: unknown, out: ContextField[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const name = clip((raw as { field?: unknown }).field, 80);
  if (!name) return;
  pushField(out, { name, type: 'date' });
}

function collectQuestions(
  raw: unknown,
  out: ContextField[],
  depth: number,
): void {
  if (depth > 4 || !Array.isArray(raw)) return;
  for (const question of raw) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      continue;
    }
    const rec = question as Record<string, unknown>;
    const bind =
      rec.bindTo && typeof rec.bindTo === 'object' && !Array.isArray(rec.bindTo)
        ? (rec.bindTo as Record<string, unknown>)
        : null;
    const name = clip(bind?.column, 80) ?? clip(rec.id, 80);
    const label = clip(rec.label, 120);
    if (name) {
      pushField(out, {
        name,
        label: label ?? name,
        type: clip(rec.type, 40),
      });
    }
    collectQuestions(rec.children, out, depth + 1);
    collectQuestions(rec.questions, out, depth + 1);
  }
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
