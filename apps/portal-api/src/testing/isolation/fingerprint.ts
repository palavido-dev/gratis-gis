// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A fingerprint of everything one organization owns, to prove that a
// request from another org changed none of it.
//
// Each table is filtered to the org's rows by whichever ownership
// columns it has (org id, item, user, group, thread). A table with none
// of them is install-wide and is left out; the list of those is kept
// so a reviewer can see what is not covered.

import type { Pool } from 'pg';

/** Columns that change on every sign-in or key use and say nothing about isolation. */
const NOISE_COLUMNS = ['last_seen_at', 'last_used_at'];

type Owned = { table: string; where: string };

const ITEM_COLUMNS = [
  'item_id',
  'source_item_id',
  'target_item_id',
  'script_id',
  'form_id',
  'map_id',
];
const USER_COLUMNS = ['user_id', 'created_by', 'author_id', 'owner_id', 'principal_id'];

let plan: { owned: Owned[]; skipped: string[] } | undefined;

async function buildPlan(pool: Pool): Promise<{ owned: Owned[]; skipped: string[] }> {
  const { rows } = await pool.query<{ table_name: string; cols: string[] }>(
    `SELECT c.table_name, array_agg(c.column_name::text) AS cols
       FROM information_schema.columns c
       JOIN pg_class k ON k.relname = c.table_name AND NOT k.relispartition
       JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
      WHERE c.table_schema = 'public' AND k.relkind IN ('r', 'p')
      GROUP BY c.table_name ORDER BY c.table_name`,
  );
  const owned: Owned[] = [];
  const skipped: string[] = [];
  for (const { table_name: t, cols } of rows) {
    const has = (c: string): boolean => cols.includes(c);
    const parts: string[] = [];
    if (t === 'organization') parts.push('t.id = $1');
    if (t === 'observation')
      parts.push(`split_part(t.scope, ':', 2) IN (SELECT id::text FROM item WHERE org_id = $1)`);
    if (has('org_id')) parts.push('t.org_id = $1');
    for (const c of ITEM_COLUMNS)
      if (has(c)) parts.push(`t.${c} IN (SELECT id FROM item WHERE org_id = $1)`);
    for (const c of USER_COLUMNS)
      if (has(c)) parts.push(`t.${c} IN (SELECT id FROM "user" WHERE org_id = $1)`);
    if (has('group_id')) parts.push(`t.group_id IN (SELECT id FROM "group" WHERE org_id = $1)`);
    if (has('thread_id'))
      parts.push(
        `t.thread_id IN (SELECT ct.id FROM comment_thread ct JOIN item i ON i.id = ct.item_id WHERE i.org_id = $1)`,
      );
    if (parts.length === 0) skipped.push(t);
    else owned.push({ table: t, where: parts.join(' OR ') });
  }
  return { owned, skipped };
}

export type Fingerprint = Map<string, string>;

/** Per-table digest of the rows `orgId` owns. */
export async function fingerprint(pool: Pool, orgId: string): Promise<Fingerprint> {
  plan ??= await buildPlan(pool);
  const noise = `'{${NOISE_COLUMNS.join(',')}}'::text[]`;
  const sql = plan.owned
    .map(
      ({ table, where }) =>
        `SELECT '${table}' AS t, md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS h
           FROM (SELECT (to_jsonb(t) - ${noise})::text AS r FROM "${table}" t WHERE ${where}) s`,
    )
    .join('\nUNION ALL\n');
  const { rows } = await pool.query<{ t: string; h: string }>(sql, [orgId]);
  return new Map(rows.map((r) => [r.t, r.h]));
}

/** Tables whose digest differs. */
export function changedTables(before: Fingerprint, after: Fingerprint): string[] {
  const out: string[] = [];
  for (const [t, h] of after) if (before.get(t) !== h) out.push(t);
  return out;
}

/** Install-wide tables the fingerprint cannot attribute to an org. */
export async function unattributedTables(pool: Pool): Promise<string[]> {
  plan ??= await buildPlan(pool);
  return plan.skipped;
}

/** Tests only: forget the table plan (a new database). */
export function resetFingerprintPlan(): void {
  plan = undefined;
}
