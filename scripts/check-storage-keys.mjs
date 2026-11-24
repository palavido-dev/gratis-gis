#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// New object keys are built in one place: storageKey() and orgPrefix()
// in apps/portal-api/src/storage/object-keys.ts, and storage_key() and
// org_prefix() in the analysis worker. They put every new object under
// its organization (`<kind>/o/<orgId>/...`). This check fails when a
// key is built by hand anywhere else:
//
//   - a template literal that starts with a storage kind and a slash
//     followed by an interpolation (`item-file/${...}`);
//   - a template literal with randomUUID() as a whole path segment;
//   - in the worker, an f-string that starts with a storage kind, or
//     one that interpolates uuid.uuid4(), outside the two helpers.
//
//   node scripts/check-storage-keys.mjs              # check this checkout
//   node scripts/check-storage-keys.mjs --self-test  # fixtures, then this checkout
//
// Test files (*.spec.ts, test_*.py) and src/testing/ are skipped. Plain
// Node, no dependencies.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = 'apps/portal-api/src';
const WORKER = 'tools/pointcloud-worker/runner.py';
const HELPER = 'apps/portal-api/src/storage/object-keys.ts';

const KINDS = [
  'item-thumb',
  'group-thumb',
  'user-avatar',
  'org-hero',
  'feature-attachment',
  'item-file',
  'item-tile-layer',
  'item-point-cloud',
  'map-icon',
  'feedback-screenshot',
  'offline-package',
  'analysis-artifact',
  'sam-embed',
  'ingest-upload',
];
const KIND_GROUP = `(?:${KINDS.join('|')})`;

// Every pattern is anchored on a fixed opening character and uses only
// bounded repetition, so each line costs the same whatever it holds.
const TS_RULES = [
  { name: 'kind-prefixed template', re: new RegExp(`\`${KIND_GROUP}/\\$\\{`) },
  // A path segment that is a fresh UUID: `.../${randomUUID()}`.
  { name: 'random key in a template', re: /`[^`\n]{0,300}\/\$\{\s{0,4}randomUUID\(\)/ },
];
const PY_RULES = [
  { name: 'kind-prefixed f-string', re: new RegExp(`\\bf["']${KIND_GROUP}/`) },
  { name: 'random key in an f-string', re: /\bf["'][^"'\n]{0,300}\{uuid\.uuid4\(\)\}/ },
];

/** Blank out // and /* *\/ comments, keeping line breaks. */
function stripTsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

export function findTs(src) {
  const out = [];
  stripTsComments(src)
    .split('\n')
    .forEach((line, i) => {
      for (const rule of TS_RULES) if (rule.re.test(line)) out.push({ line: i + 1, rule: rule.name });
    });
  return out;
}

export function findPy(src) {
  const out = [];
  let inHelper = false;
  src.split('\n').forEach((line, i) => {
    const def = /^def (\w{1,64})\(/.exec(line);
    if (def) inHelper = def[1] === 'storage_key' || def[1] === 'org_prefix';
    if (inHelper) return;
    const code = line.replace(/^\s{0,40}#.*$/, '');
    for (const rule of PY_RULES) if (rule.re.test(code)) out.push({ line: i + 1, rule: rule.name });
  });
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'testing') continue;
      out.push(...walk(p));
    } else if (entry.name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function checkCheckout() {
  const problems = [];
  for (const file of walk(join(ROOT, API_DIR))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel === HELPER) continue;
    for (const hit of findTs(readFileSync(file, 'utf8'))) problems.push(`${rel}:${hit.line} ${hit.rule}`);
  }
  for (const hit of findPy(readFileSync(join(ROOT, WORKER), 'utf8'))) {
    problems.push(`${WORKER}:${hit.line} ${hit.rule}`);
  }
  return problems;
}

function selfTest() {
  const bad = [
    'const k = `item-file/${randomUUID()}`;',
    'const k = `${kind}/${randomUUID()}`;',
    'const k = `sam-embed/${itemId}/${z}.bin`;',
  ];
  const good = [
    'const k = storageKey(kind, orgId);',
    '// const k = `item-file/${randomUUID()}`;',
    'const id = randomUUID();',
    'const p = `${kind}/${orgPart}${key}`;',
    'const path = `/vsimem/elev-mosaic-${randomUUID()}.png`;',
    'const purpose = `direct-${randomUUID()}`;',
  ];
  const fails = [];
  for (const s of bad) if (findTs(s).length === 0) fails.push(`missed: ${s}`);
  for (const s of good) if (findTs(s).length !== 0) fails.push(`flagged: ${s}`);
  const pyBad = 'x = 1\n    key = f"item-tile-layer/{uuid.uuid4()}"\n';
  const pyGood = 'def storage_key(kind, org):\n    return f"{org_prefix(kind, org)}{uuid.uuid4()}"\n';
  if (findPy(pyBad).length === 0) fails.push('missed the worker f-string');
  if (findPy(pyGood).length !== 0) fails.push('flagged the worker helper');
  return fails;
}

const args = new Set(process.argv.slice(2));
if (args.has('--self-test')) {
  const fails = selfTest();
  if (fails.length > 0) {
    console.error(`check-storage-keys self-test failed:\n  ${fails.join('\n  ')}`);
    process.exit(1);
  }
  console.log('check-storage-keys self-test passed');
}
const problems = checkCheckout();
if (problems.length > 0) {
  console.error(
    'Object keys built outside storage/object-keys.ts (use storageKey or orgPrefix):\n  ' +
      problems.join('\n  '),
  );
  process.exit(1);
}
console.log('check-storage-keys: every new key comes from the shared helper');
