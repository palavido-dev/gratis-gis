#!/usr/bin/env node
/**
 * One-off text sweep for the global "no em-dashes" rule
 * (`.claude/CLAUDE.md`).
 *
 * Walks every source file under apps/, packages/, docs/, infra/,
 * and scripts/ (minus node_modules / dist / .next / .turbo /
 * migrations) and rewrites em-dash (U+2014) usages to a compliant
 * alternative based on context:
 *
 *   `: `        ->  `: `   (parenthetical, mid-clause)
 *   ` -$`        ->  ``     (trailing dash at end of line / stops word)
 *   `-`          ->  `-`    (everything else: stuck-to-words, ranges, etc.)
 *
 * The contextual passes run in order (longest match first) so the
 * common `space dash space` form gets the colon treatment instead of
 * collapsing to a thin single-hyphen "X - Y" that reads as a range.
 *
 * Idempotent: a file with no em-dashes left is a no-op. Run again
 * after a manual cleanup if the codebase regressed.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['apps', 'packages', 'docs', 'infra', 'scripts'];
const EXT = new Set([
  '.ts',
  '.tsx',
  '.md',
  '.json',
  '.mjs',
  '.cjs',
  '.js',
  '.sql',
  '.yml',
  '.yaml',
  '.css',
  '.html',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'migrations',
]);
// Files where em-dashes are documented examples (the mojibake
// catalog literally has every weird character we've ever seen).
// Skipping by exact relative path keeps the catalog readable.
const SKIP_FILES = new Set(['docs/handoff/mojibake-patterns.md']);

const RULES = [
  // `: ` mid-line: most common form, written by editors that
  // auto-replace double-hyphens. Convert to a colon followed by a
  // space; reads naturally for parenthetical asides ("X: Y" ->
  // "X: Y") and matches Matt's preferred punctuation in the copy
  // we already shipped.
  [/: /g, ': '],

  // ` -` at end-of-line / before close-paren / before quote.
  // Drop the trailing dash entirely; the previous content stands
  // on its own.
  [/ -(?=\s|$|\)|"|')/g, ''],

  // Anything else: a dash stuck to a word (range, hyphenated noun,
  // "Read-only-editing"). Collapse to a single hyphen so the
  // surrounding text still reads.
  [/-/g, '-'],
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

let changed = 0;
let total = 0;
for (const root of ROOTS) {
  try {
    statSync(join(ROOT, root));
  } catch {
    continue;
  }
  const files = walk(join(ROOT, root));
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
    if (SKIP_FILES.has(rel)) continue;
    let orig;
    try {
      orig = readFileSync(f, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.warn(`${f}: skipping (open returned ENOENT)`);
        continue;
      }
      throw e;
    }
    if (!orig.includes('-')) continue;
    let next = orig;
    for (const [pattern, repl] of RULES) {
      next = next.replace(pattern, repl);
    }
    if (next !== orig) {
      writeFileSync(f, next, 'utf8');
      changed += 1;
      total += 1;
      console.log(rel);
    }
  }
}

console.log(`\nfiles rewritten: ${changed}`);
