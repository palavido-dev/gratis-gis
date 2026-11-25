#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Object keys are built and read in one place per runtime:
// apps/portal-api/src/storage/object-keys.ts (storageKey, orgPrefix,
// parseObjectKey), its web mirror apps/portal-web/src/lib/storage-key.ts,
// and storage_key(), org_prefix() and parse_object_key() in the analysis
// worker. New keys go under their organization (`<kind>/o/<orgId>/...`).
// This check fails when a key is built or matched by hand anywhere else.
//
// TypeScript (portal-api, portal-web, portal-mcp):
//   - any string or template literal that starts with a storage kind and
//     a slash ('item-file/...', `item-file/${...}`), and `${'item-file'}/`;
//   - a random UUID joined into a path: `.../${randomUUID()}`,
//     '.../' + randomUUID(), [kind, randomUUID()].join('/');
//   - an array that starts with a kind literal and is joined with '/'.
// Python (the worker):
//   - any string literal, with any prefix (f, F, r, rf, b, u ...), that
//     starts with a storage kind and a slash: covers f-strings,
//     '%'-format, .format() and '+' concatenation of such a literal;
//   - uuid.uuid4() inside an f-string, a '%'-format, .format(), a '+'
//     concatenation or a '/'.join(...);
//   - '/'.join([...]) whose first item is a kind literal.
//
// Comments are ignored; strings are read whole, so '//' inside a URL
// does not hide the rest of a line. Justified cases go in
// scripts/check-storage-keys.allow, one per line:
//   <path> | <text on the flagged line> | <reason>
//
//   node scripts/check-storage-keys.mjs              # check this checkout
//   node scripts/check-storage-keys.mjs --self-test  # fixtures, then this checkout
//
// Test files (*.spec.ts, *.test.ts, test_*.py) and the fixture files in
// FIXTURES (hand-made keys on purpose) are skipped. Plain Node, no dependencies.
//
// Catches: the forms above, written out on one line of a scanned file.
// Cannot catch: keys built through variables, path joins, split literals or across lines; it is a lint, not a guard.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TS_DIRS = ['apps/portal-api/src', 'apps/portal-web/src', 'apps/portal-mcp/src'];
const WORKER = 'tools/pointcloud-worker/runner.py';
const HELPERS = new Set([
  'apps/portal-api/src/storage/object-keys.ts',
  'apps/portal-web/src/lib/storage-key.ts',
]);
const ALLOW_FILE = 'scripts/check-storage-keys.allow';
/**
 * Test fixtures that build crafted keys on purpose (another org's key,
 * `..` segments, the older layout) to prove the owner check refuses
 * them. Listed one by one; a listed file that is gone fails the check.
 */
const FIXTURES = new Set([
  'apps/portal-api/src/testing/isolation/routes.ts',
  'apps/portal-api/src/testing/isolation/seed.ts',
  'apps/portal-api/src/testing/isolation/storage-topics.ts',
]);
/** Worker functions that are the key helpers themselves. */
const PY_HELPERS = new Set(['storage_key', 'org_prefix', 'parse_object_key']);

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
const K = `(?:${KINDS.join('|')})`;

// Every pattern starts on a fixed character and uses only bounded
// repetition, so each line costs the same whatever it holds.
const TS_RULES = [
  { name: 'kind-prefixed string', re: new RegExp(`[\`'"]${K}/`) },
  { name: 'kind-prefixed string', re: new RegExp(`\\$\\{\\s{0,4}[\`'"]${K}[\`'"]\\s{0,4}\\}/`) },
  {
    name: 'random key in a template',
    re: /`[^`\n]{0,300}\/\$\{\s{0,4}(?:crypto\.)?randomUUID\(\)/,
  },
  { name: 'random key by concatenation', re: /\+\s{0,4}(?:crypto\.)?randomUUID\(\)/ },
  { name: 'random key by join', re: /randomUUID\(\)[^\]\n]{0,200}\]\s{0,4}\.join\(\s{0,4}[`'"]\// },
  {
    name: 'kind joined into a path',
    re: new RegExp(
      `\\[\\s{0,4}[\`'"]${K}[\`'"][^\\]\\n]{0,300}\\]\\s{0,4}\\.join\\(\\s{0,4}[\`'"]/`,
    ),
  },
];
const PY_RULES = [
  { name: 'kind-prefixed string', re: new RegExp(`(?:^|[^\\w])[rRfFbBuU]{0,2}["']${K}/`) },
  {
    name: 'random key in an f-string',
    re: /(?:^|[^\w])[rR]?[fF][rR]?["'][^"'\n]{0,300}\{\s{0,4}(?:str\()?uuid\.uuid4\(\)/,
  },
  { name: 'random key by format', re: /["']\s{0,4}%\s{0,4}[^\n]{0,300}uuid\.uuid4\(\)/ },
  { name: 'random key by format', re: /\.format\([^\n]{0,300}uuid\.uuid4\(\)/ },
  { name: 'random key by concatenation', re: /\+\s{0,4}str\(\s{0,4}uuid\.uuid4\(\)/ },
  { name: 'random key by join', re: /["']\/["']\.join\([^\n]{0,300}uuid\.uuid4\(\)/ },
  {
    name: 'kind joined into a path',
    re: new RegExp(`["']/["']\\.join\\(\\s{0,4}[\\[(]\\s{0,4}["']${K}["']`),
  },
];

/** A character after which `/` starts a regular expression, not a division. */
const REGEX_BEFORE = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * TypeScript source with comments blanked (line breaks kept) and
 * strings, templates and regular expressions left as they are. A small
 * scanner, so a `//` inside a string or a regular expression is not
 * taken for a comment.
 */
export function blankTsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Stack of template states: each entry is the brace depth at which a
  // `${` opened, so the matching `}` returns to the template.
  const templates = [];
  let depth = 0;
  let last = '';
  const copyQuoted = (q) => {
    out += src[i];
    i += 1;
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\' && i + 1 < n) {
        out += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      out += src[i];
      i += 1;
    }
    if (i < n) {
      out += src[i];
      i += 1;
    }
  };
  const copyTemplate = () => {
    // At a backtick or just after the `}` that closed an interpolation.
    while (i < n) {
      const c = src[i];
      if (c === '\\' && i + 1 < n) {
        out += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        out += c;
        i += 1;
        return false;
      }
      if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        templates.push(depth);
        depth += 1;
        return true;
      }
      out += c;
      i += 1;
    }
    return false;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      copyQuoted(c);
      last = 'x';
      continue;
    }
    if (c === '`') {
      out += c;
      i += 1;
      copyTemplate();
      last = 'x';
      continue;
    }
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        out += c;
        i += 1;
        copyTemplate();
        last = 'x';
        continue;
      }
    }
    if (c === '/' && REGEX_BEFORE.has(last)) {
      // A regular expression literal: copy to its closing slash.
      out += c;
      i += 1;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\' && i + 1 < n) {
          out += r + src[i + 1];
          i += 2;
          continue;
        }
        out += r;
        i += 1;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      last = 'x';
      continue;
    }
    out += c;
    i += 1;
    if (!/\s/.test(c)) last = /[\w$)\]]/.test(c) ? 'x' : c;
    else if (c === '\n') last = last === 'x' ? 'x' : last;
  }
  return out;
}

export function findTs(src) {
  const out = [];
  blankTsComments(src)
    .split('\n')
    .forEach((line, i) => {
      for (const rule of TS_RULES) {
        if (rule.re.test(line)) {
          out.push({ line: i + 1, rule: rule.name, text: line.trim() });
          break;
        }
      }
    });
  return out;
}

/** A Python line with a trailing `#` comment removed (outside strings). */
function stripPyComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

export function findPy(src) {
  const out = [];
  let inHelper = false;
  src.split('\n').forEach((line, i) => {
    const def = /^def (\w{1,64})\(/.exec(line);
    if (def) inHelper = PY_HELPERS.has(def[1]);
    else if (/^\S/.test(line)) inHelper = false;
    if (inHelper) return;
    const code = stripPyComment(line);
    for (const rule of PY_RULES) {
      if (rule.re.test(code)) {
        out.push({ line: i + 1, rule: rule.name, text: line.trim() });
        break;
      }
    }
  });
  return out;
}

/** Allow entries: path, text the flagged line must contain, reason. */
export function parseAllow(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(' | ');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2].trim()) {
      throw new Error(`${ALLOW_FILE}:${i + 1}: expected "<path> | <text> | <reason>"`);
    }
    out.push({
      path: parts[0].trim(),
      text: parts[1].trim(),
      reason: parts[2].trim(),
      used: false,
    });
  });
  return out;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...walk(p));
    } else if (
      /\.(ts|tsx|mts|mjs)$/.test(entry.name) &&
      !/\.(spec|test)\.(ts|tsx|mts|mjs)$/.test(entry.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

function checkCheckout() {
  const allow = parseAllow(readFileSync(join(ROOT, ALLOW_FILE), 'utf8'));
  const problems = [];
  const report = (rel, hit) => {
    const ok = allow.find((a) => a.path === rel && hit.text.includes(a.text));
    if (ok) {
      ok.used = true;
      return;
    }
    problems.push(`${rel}:${hit.line} ${hit.rule}: ${hit.text}`);
  };
  const fixturesSeen = new Set();
  for (const dir of TS_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (HELPERS.has(rel)) continue;
      if (FIXTURES.has(rel)) {
        fixturesSeen.add(rel);
        continue;
      }
      for (const hit of findTs(readFileSync(file, 'utf8'))) report(rel, hit);
    }
  }
  for (const hit of findPy(readFileSync(join(ROOT, WORKER), 'utf8'))) report(WORKER, hit);
  for (const f of FIXTURES) {
    if (!fixturesSeen.has(f))
      problems.push(`fixture file listed in FIXTURES is gone, remove it: ${f}`);
  }
  for (const a of allow) {
    if (!a.used)
      problems.push(`${ALLOW_FILE}: entry matches nothing, remove it: ${a.path} | ${a.text}`);
  }
  return problems;
}

function selfTest() {
  const tsBad = [
    'const k = `item-file/${randomUUID()}`;',
    'const k = `${kind}/${randomUUID()}`;',
    'const k = `sam-embed/${itemId}/${z}.bin`;',
    "const k = 'item-file/' + randomUUID();",
    'const k = "item-file/" + id;',
    "const k = 'item-file/abc';",
    'const k = `item-file/x`;',
    "const k = ['item-file', randomUUID()].join('/');",
    "const k = [kind, randomUUID()].join('/');",
    "const k = [kind, crypto.randomUUID()].join('/');",
    "const k = kind + '/' + randomUUID();",
    "const k = kind + '/' + crypto.randomUUID();",
    "const k = `${'item-file'}/${id}`;",
    "const u = 'http://x/'; const k = 'item-file/' + id;",
    "/* c */ const k = 'item-file/' + id;",
    "const k = `a${b}` + 'map-icon/' + id;",
    "const k = ['user-avatar', 'o', org, id].join('/');",
    "x = { a: `${b}` }; const k = 'org-hero/' + id;",
  ];
  const tsGood = [
    'const k = storageKey(kind, orgId);',
    "if (isKeyOfKind(k, 'item-file')) return;",
    "// const k = 'item-file/' + randomUUID();",
    "/* const k = 'item-file/' + id; */",
    'const id = randomUUID();',
    'const p = `${kind}/${orgPart}${key}`;',
    'const path = `/vsimem/elev-mosaic-${randomUUID()}.png`;',
    'const purpose = `direct-${randomUUID()}`;',
    "const like = '%/item-thumb/%';",
    'const arn = `arn:aws:s3:::${bucket}/item-thumb/*`;',
    'const re = /^storage\\/private\\/(?:item-file|map-icon)\\//;',
    "const kind = 'item-file';",
  ];
  const fails = [];
  for (const s of tsBad) if (findTs(s).length === 0) fails.push(`missed: ${s}`);
  for (const s of tsGood) if (findTs(s).length !== 0) fails.push(`flagged: ${s}`);
  // A multi-line comment hides nothing after it ends.
  if (
    findTs("/*\n x\n*/\nconst k = 'item-file/' + id;")
      .map((h) => h.line)
      .join() !== '4'
  ) {
    fails.push('missed a key after a multi-line comment');
  }
  const pyBad = [
    'key = f"item-tile-layer/{uuid.uuid4()}"',
    'key = F"item-file/{x}"',
    'key = rf"item-file/{x}"',
    'key = Rf"item-file/{x}"',
    'key = "item-file/%s" % x',
    'key = "item-file/{}".format(x)',
    'key = "item-file/" + str(uuid.uuid4())',
    'key = "/".join(["item-file", str(uuid.uuid4())])',
    'key = "/".join(("item-file", x))',
    'key = "%s/%s" % (kind, uuid.uuid4())',
    'key = "{}/{}".format(kind, uuid.uuid4())',
    'key = kind + "/" + str(uuid.uuid4())',
    'key = f"{kind}/{uuid.uuid4()}"',
    'key = F"{kind}/{str(uuid.uuid4())}"',
    "key = 'item-file/x'",
    'x = 1  # c\nkey = "sam-embed/" + item',
  ];
  const pyGood = [
    'def storage_key(kind, org):\n    return f"{org_prefix(kind, org)}{uuid.uuid4()}"',
    '# key = "item-file/" + x',
    'x = "item-file"',
    'parsed = parse_object_key(key)',
    'token = str(uuid.uuid4())',
    'msg = "see # item-file/x"  # a comment',
  ];
  for (const s of pyBad) if (findPy(`x = 1\n${s}\n`).length === 0) fails.push(`missed (py): ${s}`);
  for (const s of pyGood) if (findPy(`${s}\n`).length !== 0) fails.push(`flagged (py): ${s}`);
  // A helper's body is skipped only until the next top-level line.
  if (findPy('def org_prefix(k, o):\n    return 1\nKEY = "item-file/" + x\n').length !== 1) {
    fails.push('a key after a helper was skipped');
  }
  // Folders named testing are read too; only the listed fixtures are skipped.
  const testingFiles = walk(join(ROOT, 'apps/portal-api/src/testing')).map((f) =>
    relative(ROOT, f).split(sep).join('/'),
  );
  if (testingFiles.filter((f) => !FIXTURES.has(f)).length === 0) {
    fails.push('files under a testing folder were skipped');
  }
  // Allow file format.
  try {
    parseAllow('a.ts | text');
    fails.push('accepted an allow entry with no reason');
  } catch {
    // expected
  }
  if (parseAllow('# c\n\na.ts | x | because\n').length !== 1) fails.push('allow parse');
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
    'Object keys built or matched outside the shared key modules (use storageKey, orgPrefix, ' +
      'parseObjectKey or isKeyOfKind; or add a justified line to ' +
      `${ALLOW_FILE}):\n  ` +
      problems.join('\n  '),
  );
  process.exit(1);
}
console.log('check-storage-keys: every key is built and read through the shared modules');
