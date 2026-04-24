#!/usr/bin/env node
/**
 * One-off text sweep. Walks every source file under apps/, packages/,
 * docs/, infra/ (minus node_modules / dist / .next / .turbo /
 * migrations), detects the classic "UTF-8 decoded as Latin-1 and
 * re-encoded as UTF-8" mojibake, and rewrites the garbled sequences
 * back to the intended unicode codepoint.
 *
 * Patterns covered (longest / most-decoded first so we don't partial-
 * match a longer sequence mid-replacement):
 *   Ã¢â‚¬â€  -> —   (triple-encoded em-dash)
 *   Ã¢â‚¬â€˜ -> '   (triple-encoded left single quote)
 *   Ã¢â‚¬â€™ -> '   (triple-encoded right single quote)
 *   Ã¢â‚¬â€œ -> –   (triple-encoded en-dash, sometimes collapses here)
 *   Ã¢â‚¬Â¦ -> …   (triple-encoded ellipsis)
 *   â€"    -> —   (double-encoded em-dash)
 *   â€"    -> –   (double-encoded en-dash — identical leading bytes;
 *                  our rule emits em-dash since source usage is 10x
 *                  more common; spot-fix the few true en-dashes later)
 *   â€¦    -> …
 *   â€™    -> '
 *   â€˜    -> '
 *   â€œ    -> "
 *   â€ (alone) -> "
 *   Ã©     -> é   (accented Latin-1 characters double-encoded)
 *   Ã­     -> í
 *   Ã³     -> ó
 *   Ã¡     -> á
 *   Ã¼     -> ü
 *
 * We intentionally don't try to fix EVERY possible double-encoded
 * accented letter — just the handful actually present in our source.
 * A grep after the sweep will catch any leftovers.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['apps', 'packages', 'docs', 'infra'];
const EXT = new Set(['.ts', '.tsx', '.md', '.json', '.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'migrations',
]);

// Ordered: longer / more corrupt forms first so they match before
// their own prefixes get rewritten by a narrower rule.
const RULES = [
  // --- Quadruple-encoded (ÃƒÂ¢ lead) ---
  // Some files were re-saved enough times that the mojibake cycled
  // once more. Do these FIRST because their prefixes will otherwise
  // be rewritten by the shorter Ãƒ / Ã² rules and we lose information.
  ['ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â', '—'],       // em-dash, 4x
  ['ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢', "'"],        // right single quote, 4x
  ['ÃƒÂ¢Ã¢â€šÂ¬ÃÅ"', '"'],            // left double quote, 4x
  ['ÃƒÂ¢Ã¢â€šÂ¬Ã', '"'],              // right double quote, 4x (ends partial)
  ['ÃƒÂ©', 'é'],
  ['ÃƒÂ­', 'í'],
  ['ÃƒÂ³', 'ó'],
  ['ÃƒÂ¡', 'á'],
  ['ÃƒÂ¼', 'ü'],
  ['ÃƒÂ±', 'ñ'],

  // --- Triple-encoded (Ã¢â‚¬ lead) ---
  // Two variants show up because the terminal 0x94/0x9D byte either
  // survived as a U+009D control and re-encoded (â€ + C2 9D, trimmed
  // visually to â€) or was re-read as cp1252's U+201D (") and stayed
  // visible. Cover both.
  ['Ã¢â‚¬”', '—'],   // em-dash, trailing " (U+201D)
  ['Ã¢â‚¬â€', '—'],  // em-dash, trailing â€ (control-9D stripped)
  ['Ã¢â‚¬™', "'"],   // right single quote, trailing ™ (U+2122)
  ['Ã¢â‚¬â€™', "'"], // right single quote, other form
  ['Ã¢â‚¬˜', "'"],   // left single quote
  ['Ã¢â‚¬â€˜', "'"],
  ['Ã¢â‚¬œ', '"'],   // left double quote
  ['Ã¢â‚¬â€œ', '–'], // en-dash
  ['Ã¢â‚¬Â¦', '…'],  // ellipsis
  ['Ã¢Å““', '✓'],   // check mark

  // --- Double-encoded (â€ lead) ---
  ['â€"', '—'],
  ['â€¦', '…'],
  ['â€™', "'"],
  ['â€˜', "'"],
  ['â€œ', '"'],
  ['â€', '"'],   // bare â€ = right double quote, leave LAST in group

  // --- Double-encoded Latin accents ---
  ['Ã©', 'é'],
  ['Ã­', 'í'],
  ['Ã³', 'ó'],
  ['Ã¡', 'á'],
  ['Ã¼', 'ü'],
  ['Ã±', 'ñ'],

  // --- Double-encoded middle-dot & non-breaking markers ---
  ['Ã‚·', '·'],
  ['Ã‚ ', ' '],     // nbsp decoded twice
  ['Ã‚©', '©'],
  ['Ã‚®', '®'],
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
let hitTotal = 0;
for (const root of ROOTS) {
  try {
    statSync(join(ROOT, root));
  } catch {
    continue;
  }
  const files = walk(join(ROOT, root));
  for (const f of files) {
    // Same Windows-bind-mount ENOENT quirk as fix-invalid-utf8.mjs:
    // some files nested under bracketed Next.js dynamic-route dirs
    // (`[id]`) can be stat'd but not open'd from this sandbox. Skip
    // them so the rest of the sweep still runs.
    let orig;
    try {
      orig = readFileSync(f, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.warn(`${f}: skipping (open returned ENOENT despite stat)`);
        continue;
      }
      throw e;
    }
    let next = orig;
    let hits = 0;
    for (const [from, to] of RULES) {
      if (!next.includes(from)) continue;
      const before = next;
      next = next.split(from).join(to);
      if (next !== before) hits++;
    }
    if (hits > 0 && next !== orig) {
      writeFileSync(f, next, 'utf8');
      changed++;
      hitTotal += hits;
      console.log(`${f}  (${hits} rule-hits)`);
    }
  }
}

console.log(`\nfiles rewritten: ${changed}`);
console.log(`rule-hits total: ${hitTotal}`);
