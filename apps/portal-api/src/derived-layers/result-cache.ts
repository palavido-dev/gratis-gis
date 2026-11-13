// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-process cache of derived-layer read results (2026-11 review,
 * 07-7). A derived layer used to recompute its whole pipeline over the
 * whole source on every read, so a dissolve or clip over a big layer
 * cost every viewer of every map the full price, and could time out
 * for all of them.
 *
 * Key: a hash of the composed SQL and its parameters (which carry the
 * full recipe chain and the request's bbox, time and boundary), plus
 * the write version of every source layer the SQL reads. A write to
 * any of them changes the version, so the next read misses and
 * recomputes. The TTL bounds anything the version cannot see, such as
 * a boundary item edited in place.
 */

/** How long a result is served without recomputing. */
export const DERIVED_RESULT_TTL_MS = 10 * 60 * 1000;

/** Most results held at once per process. */
const MAX_ENTRIES = 64;

/**
 * Rough memory budget for held results, counted as the length of the
 * geometry and property text. Big results beyond this push out the
 * oldest ones; a single result over it is not cached at all.
 */
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;

/** Statement timeout for the version probe, as for tile versions. */
const VERSION_PROBE_TIMEOUT_MS = 3_000;

export interface DerivedRow {
  global_id: string;
  geom: string | null;
  properties: Record<string, unknown> | null;
}

interface Entry {
  at: number;
  rows: DerivedRow[];
  chars: number;
}

/**
 * Every data_layer scope the SQL reads. dataLayerSourceSqlFragment
 * embeds each as a single-quoted literal with quotes doubled.
 */
export function scopesInSql(sql: string): string[] {
  const out = new Set<string>();
  const re = /'(data_layer:[0-9a-fA-F-]{36}:(?:[^']|'')*)'/g;
  for (const m of sql.matchAll(re)) out.add(m[1]!.replace(/''/g, "'"));
  return [...out].sort();
}

export function queryHash(sql: string, params: unknown[]): string {
  return createHash('sha256')
    .update(sql)
    .update('\0')
    .update(JSON.stringify(params))
    .digest('hex');
}

/**
 * The write version of each scope, in one statement. Same recipe as
 * DataLayerEngine.scopeDataVersion: row count, a sum of row id hashes
 * (catches a replace that keeps the count) and the count of rows that
 * are not in effect yet.
 */
export async function scopeVersions(
  prisma: PrismaService,
  scopes: string[],
): Promise<string> {
  if (scopes.length === 0) return '';
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL statement_timeout = ${VERSION_PROBE_TIMEOUT_MS}`,
    );
    return tx.$queryRaw<
      Array<{ scope: string; n: bigint; h: string; f: bigint }>
    >`
      SELECT scope,
             count(*) AS n,
             COALESCE(sum(hashtextextended(id::text, 0)), 0)::text AS h,
             count(*) FILTER (WHERE valid_from > now()) AS f
      FROM observation
      WHERE scope = ANY(${scopes}::text[])
      GROUP BY scope`;
  });
  const byScope = new Map(
    rows.map((r) => [r.scope, `${String(r.n)}:${r.h}:${String(r.f)}`]),
  );
  return scopes.map((s) => `${s}=${byScope.get(s) ?? '0:0:0'}`).join('|');
}

export class DerivedResultCache {
  private readonly entries = new Map<string, Entry>();
  private totalChars = 0;

  constructor(
    private readonly ttlMs = DERIVED_RESULT_TTL_MS,
    private readonly maxEntries = MAX_ENTRIES,
    private readonly maxChars = MAX_TOTAL_CHARS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): DerivedRow[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.drop(key, hit);
      return undefined;
    }
    // Re-insert so the Map's order stays least recently used first.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.rows;
  }

  set(key: string, rows: DerivedRow[]): void {
    let chars = 0;
    for (const r of rows) {
      chars += (r.geom?.length ?? 0) + 64;
      if (r.properties) chars += JSON.stringify(r.properties).length;
    }
    if (chars > this.maxChars) return;
    const old = this.entries.get(key);
    if (old) this.drop(key, old);
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries ||
        this.totalChars + chars > this.maxChars)
    ) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [
        string,
        Entry,
      ];
      this.drop(oldestKey, oldest);
    }
    this.entries.set(key, { at: this.now(), rows, chars });
    this.totalChars += chars;
  }

  get size(): number {
    return this.entries.size;
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalChars -= entry.chars;
  }
}
