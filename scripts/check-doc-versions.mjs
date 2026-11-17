#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fail when README.md, CONTRIBUTING.md or CITATION.cff name a GratisGIS
// version that differs from the root package.json version.
//
//   node scripts/check-doc-versions.mjs              # this checkout
//   node scripts/check-doc-versions.mjs --self-test  # fixtures, then this checkout
//   pnpm check:doc-versions
//
// Only the project's own version statements are read, so third-party
// versions (the CFF spec version, Node, PostGIS, ...) never trip it:
//   README.md        **Status:** [vX.Y.Z](./CHANGELOG.md)
//   CONTRIBUTING.md  GratisGIS is at **vX.Y.Z**
//   CITATION.cff     version: X.Y.Z   (top-level key, not cff-version)
// Each statement must be present. If you reword one, update its
// pattern here in the same change so the check keeps covering it.
//
// CHANGELOG.md and apps/portal-web/content/changelog/user-visible.md
// hold release history and are never checked.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';

/** Where each document states the project version. */
const RULES = [
  {
    file: 'README.md',
    label: '**Status:** [vX.Y.Z]',
    pattern: new RegExp(`\\*\\*Status:\\*\\*\\s*\\[?v${SEMVER}`, 'g'),
  },
  {
    file: 'CONTRIBUTING.md',
    label: 'GratisGIS is at **vX.Y.Z**',
    pattern: new RegExp(`GratisGIS is at \\*\\*v${SEMVER}\\*\\*`, 'g'),
  },
  {
    file: 'CITATION.cff',
    label: 'version: X.Y.Z',
    pattern: new RegExp(`^version:\\s*['"]?${SEMVER}['"]?\\s*$`, 'gm'),
  },
];

/**
 * Problems found in a set of documents, as human-readable lines.
 * @param {string} expected package.json version
 * @param {Record<string, string>} docs file name to contents
 */
function findProblems(expected, docs) {
  const problems = [];
  for (const rule of RULES) {
    const text = docs[rule.file];
    if (text === undefined) {
      problems.push(`${rule.file}: file not found`);
      continue;
    }
    const found = [...text.matchAll(rule.pattern)];
    if (found.length === 0) {
      problems.push(
        `${rule.file}: no "${rule.label}" statement found. If it was reworded, update RULES in scripts/check-doc-versions.mjs.`,
      );
      continue;
    }
    for (const m of found) {
      if (m[1] !== expected) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`${rule.file}:${line}: says ${m[1]}, package.json says ${expected}`);
      }
    }
  }
  return problems;
}

function selfTest() {
  const good = {
    'README.md': '**Status:** [v2.3.4](./CHANGELOG.md). Needs Node 24.9.0 and PostGIS 3.5.2.',
    'CONTRIBUTING.md': 'GratisGIS is at **v2.3.4**. Uses MapLibre 5.6.0.',
    'CITATION.cff': "cff-version: 1.2.0\ntitle: GratisGIS\nversion: '2.3.4'\n",
  };
  const cases = [
    { name: 'all match, third-party versions ignored', docs: good, want: 0 },
    {
      name: 'stale README',
      docs: { ...good, 'README.md': '**Status:** [v2.3.3](./CHANGELOG.md).' },
      want: 1,
    },
    {
      name: 'stale CONTRIBUTING',
      docs: { ...good, 'CONTRIBUTING.md': 'GratisGIS is at **v1.2.0**.' },
      want: 1,
    },
    {
      name: 'stale CITATION, cff-version left alone',
      docs: { ...good, 'CITATION.cff': 'cff-version: 2.3.4\nversion: 2.3.3\n' },
      want: 1,
    },
    {
      name: 'statement reworded away',
      docs: { ...good, 'CONTRIBUTING.md': 'See the latest release.' },
      want: 1,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = findProblems('2.3.4', c.docs).length;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} self-test: ${c.name} (${got} problem(s), want ${c.want})`);
  }
  if (failed) {
    console.error(`check-doc-versions self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
}

function main() {
  if (process.argv.includes('--self-test')) selfTest();

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  /** @type {Record<string, string>} */
  const docs = {};
  for (const rule of RULES) {
    try {
      docs[rule.file] = readFileSync(join(root, rule.file), 'utf8');
    } catch {
      // Reported as "file not found" below.
    }
  }

  const problems = findProblems(expected, docs);
  if (problems.length) {
    console.error(`Documented GratisGIS version does not match package.json (${expected}):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`README.md, CONTRIBUTING.md and CITATION.cff all say ${expected}.`);
}

main();
