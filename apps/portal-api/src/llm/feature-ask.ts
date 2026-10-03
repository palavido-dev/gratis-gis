// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turns a question about a layer into a short attribute sample
 * and reads the model's answer back. The model may only name
 * ids that were in the sample. Geometries never enter the prompt.
 */

const STOP = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with',
  'from', 'that', 'this', 'what', 'which', 'where', 'who', 'how', 'many',
  'show', 'find', 'me', 'my', 'layer', 'layers', 'features', 'feature',
  'rows', 'row', 'please', 'are', 'is', 'was', 'were', 'be', 'been',
  'being', 'it', 'its', 'their', 'there', 'here', 'all', 'any', 'some',
  'can', 'could', 'would', 'should', 'about', 'into', 'over', 'under',
  'near', 'within', 'list', 'give', 'get', 'have', 'has', 'had',
]);

const GEOMETRY_KEYS = new Set(['geom', 'geometry', 'the_geom', 'geojson']);

export class UnusableFeatureAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableFeatureAnswer';
  }
}

export function questionTokens(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,39}/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (STOP.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length === 4) break;
  }
  return out;
}

/**
 * v1 data layers keep features on the item. They have no layer
 * list. Ids are the feature id when it has one, otherwise a
 * stable row number. Geometry is not copied.
 */
export function inlineFeatures(
  data: unknown,
): Array<{ id: string; properties: Record<string, unknown> }> {
  if (!data || typeof data !== 'object') return [];
  if ((data as { version?: unknown }).version !== 1) return [];
  const collection = (data as { data?: unknown }).data;
  if (!collection || typeof collection !== 'object') return [];
  const features = (collection as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const out: Array<{ id: string; properties: Record<string, unknown> }> = [];
  for (let index = 0; index < features.length && out.length < 200; index += 1) {
    const feature = features[index];
    if (!feature || typeof feature !== 'object') continue;
    const rawId = (feature as { id?: unknown }).id;
    const props = (feature as { properties?: unknown }).properties;
    out.push({
      id: typeof rawId === 'string' && rawId.trim() ? rawId.trim() : `row-${index + 1}`,
      properties:
        props && typeof props === 'object' && !Array.isArray(props)
          ? (props as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

/** One sample line: id plus short string attributes. Objects are skipped. */
export function attributeLine(
  id: string,
  properties: Record<string, unknown> | undefined,
): { line: string; attributes: Record<string, string> } {
  const attributes: Record<string, string> = {};
  const bits = [`id=${id}`];
  let budget = 400;
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (key.startsWith('_') || GEOMETRY_KEYS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    const text = String(value).replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!text) continue;
    const piece = `${key}=${text}`;
    if (piece.length > budget) break;
    attributes[key] = text;
    bits.push(piece);
    budget -= piece.length;
  }
  return { line: bits.join(' '), attributes };
}

export function parseFeatureAnswer(
  raw: string,
  allowed: ReadonlySet<string>,
): { answer: string; ids: string[] } {
  const root = asRecord(extractJson(raw));
  if (!root) {
    throw new UnusableFeatureAnswer('The model did not return an answer.');
  }
  const answer = typeof root.answer === 'string' ? root.answer.trim().slice(0, 500) : '';
  if (!answer) {
    throw new UnusableFeatureAnswer('The model did not return an answer.');
  }
  const ids: string[] = [];
  const rawIds = Array.isArray(root.ids) ? root.ids : [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || !allowed.has(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === 25) break;
  }
  return { answer, ids };
}

export function renderFeaturePrompt(lines: string[], question: string): {
  system: string;
  user: string;
} {
  return {
    system: [
      'You answer a question about a sample of map features.',
      'Reply with one JSON object and nothing else:',
      '{"answer":"one or two sentences","ids":["..."]}.',
      'Every id must be copied from the sample. Use an empty ids list when none match.',
      'Do not invent an id. Do not include geometry.',
    ].join(' '),
    user: `Sample:\n${lines.join('\n')}\n\nQuestion:\n${question}`,
  };
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
