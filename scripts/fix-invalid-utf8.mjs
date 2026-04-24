#!/usr/bin/env node
/**
 * Scan every source file for invalid UTF-8 byte sequences and fix the
 * handful of known corruption patterns left over from today's big
 * rename passes. We walk the same trees as the mojibake sweep but
 * operate at the byte level because the bad sequences AREN'T mojibake
 * — they're bytes that decode-to-nothing (webpack's swc-loader
 * rejects the file outright with "stream did not contain valid UTF-8").
 *
 * Patterns we know about:
 *   E2 80 C2 A2  -> E2 80 A2        // half-rewritten bullet "•"
 *                                    (the C2 A2 was leftover from a
 *                                    prior mojibake Â¢ that the cleanup
 *                                    partially fixed)
 *   E2 80 C2 BB  -> E2 80 BA        // half-rewritten "›" single right angle
 *                                    quote
 *
 * Anything else triggers a loud print + exit-1 so we notice if a new
 * pattern shows up.
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

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

// Byte-level patterns we know how to rewrite. Expressed as
// `Buffer.from(...)` so indexOf can search without going through
// JS strings (which would choke on the invalid sequences themselves).
const REPLACEMENTS = [
  // Longest patterns first so the narrower ones don't eat them.
  // Every entry here is a byte sequence that a previous pass —
  // either the rename bulk-replace or the NBSP-strip — half-broke.
  // Safest universal substitute is an ASCII em-dash "-" unless the
  // surrounding text specifically wants an arrow; we pick ascii
  // equivalents so the replacement itself is unambiguously valid.
  {
    // seed.ts "→" between quote and word: C3 83 C2 A2 E2 80 C2 A0 E2 80 99
    search: Buffer.from([0xc3, 0x83, 0xc2, 0xa2, 0xe2, 0x80, 0xc2, 0xa0, 0xe2, 0x80, 0x99]),
    replace: Buffer.from([0x2d, 0x3e]), // ->
    name: 'broken-arrow-11b',
  },
  {
    // items.service.ts "→" with a bogus space mid-sequence:
    // C3 83 C2 A2 E2 80 20 E2 80 99
    search: Buffer.from([0xc3, 0x83, 0xc2, 0xa2, 0xe2, 0x80, 0x20, 0xe2, 0x80, 0x99]),
    replace: Buffer.from([0x2d, 0x3e]), // ->
    name: 'broken-arrow-10b-split',
  },
  {
    // wizard.tsx "—" triple-mojibake (34 bytes) — exact match:
    //   C3 83 C6 92 C3 82 C2 A2 C3 83 C2 A2 E2 80 C5 A1
    //   C3 82 C2 AC C3 83 C2 A2 C3 A2 E2 80 9A C2 AC
    //   C3 82 C2 9D
    search: Buffer.from([
      0xc3, 0x83, 0xc6, 0x92, 0xc3, 0x82, 0xc2, 0xa2,
      0xc3, 0x83, 0xc2, 0xa2, 0xe2, 0x80, 0xc5, 0xa1,
      0xc3, 0x82, 0xc2, 0xac, 0xc3, 0x83, 0xc2, 0xa2,
      0xc3, 0xa2, 0xe2, 0x80, 0x9a, 0xc2, 0xac, 0xc3,
      0x82, 0xc2, 0x9d,
    ]),
    replace: Buffer.from([0x2d]), // -
    name: 'broken-emdash-triple-34b',
  },
  // Shorter patterns.
  {
    search: Buffer.from([0xe2, 0x80, 0xc2, 0xa2]),
    replace: Buffer.from([0xe2, 0x80, 0xa2]), // •
    name: 'bullet',
  },
  {
    search: Buffer.from([0xe2, 0x80, 0xc2, 0xbb]),
    replace: Buffer.from([0xe2, 0x80, 0xba]), // ›
    name: 'right-angle',
  },
];

/** Byte-level indexOf — identical semantics to Buffer#indexOf. */
function findAll(hay, needle) {
  const hits = [];
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    hits.push(i);
    i += needle.length;
  }
  return hits;
}

/**
 * Validate UTF-8 byte-by-byte. Returns an array of byte offsets
 * where invalid sequences start. Empty = file is clean UTF-8.
 */
function scanInvalid(bytes) {
  const bad = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need;
    if (b >= 0xc2 && b < 0xe0) need = 1;
    else if (b >= 0xe0 && b < 0xf0) need = 2;
    else if (b >= 0xf0 && b < 0xf5) need = 3;
    else {
      bad.push(i);
      i++;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      if (i + k >= bytes.length) {
        ok = false;
        break;
      }
      const c = bytes[i + k];
      if (c < 0x80 || c >= 0xc0) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      bad.push(i);
      i++;
    } else {
      i += need + 1;
    }
  }
  return bad;
}

let filesChanged = 0;
let unfixable = 0;
for (const root of ROOTS) {
  try {
    statSync(join(ROOT, root));
  } catch {
    continue;
  }
  for (const f of walk(join(ROOT, root))) {
    // The Windows bind-mount in our current sandbox occasionally returns
    // ENOENT on open() for files that readdir/stat report as present —
    // specifically for some files nested under bracketed Next.js dynamic
    // route dirs like `[id]`. If we can't open, log + skip so the rest
    // of the sweep still runs. (Those files are visible to the host's
    // Next.js compile chain, so any lingering corruption surfaces there.)
    let bytes;
    try {
      bytes = readFileSync(f);
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.warn(`${f}: skipping (open returned ENOENT despite stat)`);
        continue;
      }
      throw e;
    }
    if (scanInvalid(bytes).length === 0) continue;

    // Try each replacement rule.
    let changed = false;
    for (const rule of REPLACEMENTS) {
      const hits = findAll(bytes, rule.search);
      if (hits.length === 0) continue;
      // Build the new buffer with the replacement applied left-to-right.
      const next = Buffer.alloc(
        bytes.length + hits.length * (rule.replace.length - rule.search.length),
      );
      let srcIdx = 0;
      let dstIdx = 0;
      for (const hit of hits) {
        bytes.copy(next, dstIdx, srcIdx, hit);
        dstIdx += hit - srcIdx;
        rule.replace.copy(next, dstIdx);
        dstIdx += rule.replace.length;
        srcIdx = hit + rule.search.length;
      }
      bytes.copy(next, dstIdx, srcIdx, bytes.length);
      bytes = next;
      changed = true;
      console.log(`${f}: +${hits.length} ${rule.name} fixes`);
    }

    let still = scanInvalid(bytes);
    if (still.length > 0) {
      // Generic salvage: walk the file as a sequence of "runs".
      // Each ASCII byte passes through unchanged. Each maximal run
      // of non-ASCII bytes is inspected — if any byte in the run is
      // flagged by scanInvalid, replace the whole run with a single
      // ASCII hyphen; otherwise preserve it byte-for-byte. We lose
      // the original codepoint in bad runs but gain a compilable
      // file; the human can eyeball afterwards and swap the hyphen.
      //
      // Earlier version tried to push ASCII then "pop back" when it
      // hit a bad byte, but the out-array index diverged from the
      // bytes-array index after the first replacement and later
      // rewinds popped the wrong elements — corrupting unrelated
      // regions of the file. The run-based version below does a
      // single forward pass so the two indexes never need to agree.
      const out = [];
      const badSet = new Set(still);
      let i = 0;
      while (i < bytes.length) {
        if (bytes[i] < 0x80) {
          out.push(bytes[i]);
          i++;
          continue;
        }
        // Start of a non-ASCII run; find its end.
        const runStart = i;
        while (i < bytes.length && bytes[i] >= 0x80) i++;
        let hasBad = false;
        for (let j = runStart; j < i; j++) {
          if (badSet.has(j)) {
            hasBad = true;
            break;
          }
        }
        if (hasBad) {
          out.push(0x2d); // -
        } else {
          for (let j = runStart; j < i; j++) out.push(bytes[j]);
        }
      }
      bytes = Buffer.from(out);
      still = scanInvalid(bytes);
      if (still.length > 0) {
        unfixable++;
        console.error(
          `${f}: ${still.length} invalid sequence(s) remain after salvage — first at offset ${still[0]}. Context (hex):`,
        );
        const start = Math.max(0, still[0] - 8);
        const end = Math.min(bytes.length, still[0] + 8);
        const slice = bytes.subarray(start, end);
        console.error(
          '  ' +
            Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' '),
        );
      } else {
        changed = true;
        console.log(`${f}: salvaged remaining invalid sequences -> ascii`);
      }
    }

    if (changed) {
      writeFileSync(f, bytes);
      filesChanged++;
    }
  }
}

console.log(`\nfiles rewritten: ${filesChanged}`);
if (unfixable > 0) {
  console.log(`files with invalid UTF-8 we couldn't rewrite: ${unfixable}`);
  process.exit(1);
}
