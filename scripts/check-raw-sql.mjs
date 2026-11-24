#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Count hand-written SQL call sites in apps/portal-api/src and compare
// the counts per file with scripts/raw-sql-baseline.json.
//
//   node scripts/check-raw-sql.mjs              # check this checkout
//   node scripts/check-raw-sql.mjs --self-test  # fixtures, then this checkout
//   node scripts/check-raw-sql.mjs --list       # print every site, file:line
//   node scripts/check-raw-sql.mjs --update     # rewrite the baseline
//   pnpm check:raw-sql
//
// Every site must have a row in docs/security/raw-sql-inventory.md.
// The check fails when a file gains, loses or moves a site, so the
// inventory and the baseline change in the same pull request as the
// code. Run with --update only after the inventory is updated.
//
// What counts as a site (comments are ignored):
//   prisma  .$queryRaw / .$executeRaw / .$queryRawUnsafe / .$executeRawUnsafe calls
//   pg      node-postgres calls: client.query, admin.query, writer.query,
//           and this.query<...> (the CopyWriter passthrough)
//   raw     Prisma.raw(...) fragments, which put text into SQL unescaped
// Test files (*.spec.ts, *.test.ts) and src/testing/ are skipped.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAN_DIR = 'apps/portal-api/src';
const BASELINE = 'scripts/raw-sql-baseline.json';
const INVENTORY = 'docs/security/raw-sql-inventory.md';

const PATTERNS = {
  prisma: /\.\$(?:queryRaw|executeRaw)(?:Unsafe)?\s*[<(`]/g,
  pg: /\b(?:client|admin|writer)\.query\s*[<(]|\bthis\.query\s*</g,
  raw: /\bPrisma\.raw\s*\(/g,
};
const KINDS = Object.keys(PATTERNS);

/**
 * Blank out comments, keeping line breaks so line numbers stay right.
 * Strings and template literals are kept as they are: a "//" inside a
 * string is not a comment. This is a small scanner, not a full parser.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  /** @type {null | "'" | '"' | '`'} */
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i++;
  }
  return out;
}

/** Sites in one file's source: [{ kind, line }]. */
export function findSites(src) {
  const text = stripComments(src);
  const sites = [];
  for (const kind of KINDS) {
    for (const m of text.matchAll(PATTERNS[kind])) {
      const line = text.slice(0, m.index).split('\n').length;
      sites.push({ kind, line });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

function walk(dir, root, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'testing') continue;
      walk(full, root, files);
    } else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name)) {
      if (/\.(spec|test)\.[mc]?[tj]s$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      files.push(relative(root, full).split(sep).join('/'));
    }
  }
  return files;
}

/** { file: { prisma, pg, raw } } for files with at least one site. */
function countTree(root) {
  const counts = {};
  const listing = [];
  for (const file of walk(join(root, SCAN_DIR), root, []).sort()) {
    const sites = findSites(readFileSync(join(root, file), 'utf8'));
    if (!sites.length) continue;
    const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const s of sites) {
      c[s.kind]++;
      listing.push(`${file}:${s.line} ${s.kind}`);
    }
    counts[file] = c;
  }
  return { counts, listing };
}

/** Differences between the baseline and the tree, as messages. */
export function compare(baseline, actual) {
  const problems = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
  for (const file of [...files].sort()) {
    for (const kind of KINDS) {
      const want = baseline[file]?.[kind] ?? 0;
      const got = actual[file]?.[kind] ?? 0;
      if (got > want) {
        problems.push(`${file}: ${got - want} new ${kind} site(s) (baseline ${want}, now ${got})`);
      } else if (got < want) {
        problems.push(`${file}: ${want - got} ${kind} site(s) gone (baseline ${want}, now ${got})`);
      }
    }
  }
  return problems;
}

function totals(counts) {
  const t = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const c of Object.values(counts)) for (const k of KINDS) t[k] += c[k] ?? 0;
  return t;
}

function selfTest() {
  const cases = [
    { name: 'prisma tagged call', src: 'await this.prisma.$queryRaw`SELECT 1`;', want: 1 },
    { name: 'prisma generic call', src: 'await tx.$queryRaw<{ a: number }[]>`SELECT 1`;', want: 1 },
    { name: 'unsafe call', src: 'await db.$executeRawUnsafe(sql, a);', want: 1 },
    { name: 'pg client call', src: "await client.query('SELECT 1');", want: 1 },
    { name: 'Prisma.raw fragment', src: "const d = Prisma.raw('DESC');", want: 1 },
    { name: 'line comment ignored', src: '// use $queryRaw`x` or client.query(', want: 0 },
    { name: 'block comment ignored', src: '/* tx.$executeRaw`x` */', want: 0 },
    { name: 'type reference ignored', src: "type R = Pick<Prisma.TransactionClient, '$queryRaw'>;", want: 0 },
    { name: 'url in string is not a comment', src: "const u = 'http://x'; await c.$queryRaw`SELECT 1`;", want: 1 },
    { name: 'non-sql query call ignored', src: 'await this.features.query(id, opts);', want: 0 },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = findSites(c.src).length;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test: ${c.name} (${got} site(s), want ${c.want})`);
  }
  const base = { 'a.ts': { prisma: 2, pg: 0, raw: 0 } };
  const cmp = [
    { name: 'same counts pass', actual: { 'a.ts': { prisma: 2, pg: 0, raw: 0 } }, want: 0 },
    { name: 'new site fails', actual: { 'a.ts': { prisma: 3, pg: 0, raw: 0 } }, want: 1 },
    { name: 'moved site fails twice', actual: { 'a.ts': { prisma: 1, pg: 0, raw: 0 }, 'b.ts': { prisma: 1, pg: 0, raw: 0 } }, want: 2 },
    { name: 'removed file fails', actual: {}, want: 1 },
  ];
  for (const c of cmp) {
    const got = compare(base, c.actual).length;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test: ${c.name} (${got} problem(s), want ${c.want})`);
  }
  if (failed) {
    console.error(`check-raw-sql self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { counts, listing } = countTree(root);
  const t = totals(counts);
  const summary = `${t.prisma + t.pg + t.raw} sites (prisma ${t.prisma}, pg ${t.pg}, raw ${t.raw}) in ${Object.keys(counts).length} files`;

  if (args.includes('--list')) {
    for (const l of listing) console.log(l);
    console.log(summary);
    return;
  }

  if (args.includes('--update')) {
    const body = { _readme: `Raw SQL sites per file. Every site has a row in ${INVENTORY}. Regenerate with: node scripts/check-raw-sql.mjs --update`, files: counts };
    writeFileSync(join(root, BASELINE), `${JSON.stringify(body, null, 2)}\n`);
    console.log(`Wrote ${BASELINE}: ${summary}.`);
    return;
  }

  if (!existsSync(join(root, BASELINE))) {
    console.error(`${BASELINE} is missing. Run: node scripts/check-raw-sql.mjs --update`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8')).files ?? {};
  const problems = compare(baseline, counts);
  if (problems.length) {
    console.error('Raw SQL call sites differ from the baseline:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('');
    console.error(`Add each new or moved site to ${INVENTORY} (file, function,`);
    console.error('tables, where the id comes from, and the access check), remove rows');
    console.error('for sites that are gone, then update the baseline:');
    console.error('  node scripts/check-raw-sql.mjs --update');
    console.error('List every site with: node scripts/check-raw-sql.mjs --list');
    process.exit(1);
  }
  console.log(`Raw SQL sites match the baseline: ${summary}.`);
}

main();
