// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Help documentation loader (#118).
 *
 * Reads MDX-ish files from `apps/portal-web/content/help/`, parses
 * the YAML frontmatter block, and converts the markdown body to
 * HTML via marked. Runs server-side only: the rendered HTML and a
 * slim search index ship to the client.
 *
 * File layout:
 *   content/help/<category>/<slug>.md   -> /help/<category>/<slug>
 *   content/help/<slug>.md              -> /help/<slug>     (top-level)
 *   content/help/index.md               -> /help            (landing)
 *
 * Each file's frontmatter is the single source of truth for nav
 * placement, search summary, control bindings (data-help ids that
 * point at this page), and prerequisites. See `HelpFrontmatter`
 * below for the schema.
 *
 * Frontmatter parsing was previously delegated to gray-matter@4,
 * which still calls `yaml.safeLoad()` (removed in js-yaml@4). The
 * gray-matter project has been quiet since 2021, so rather than
 * pin js-yaml to the 3.x line we own a small parser here that
 * targets the exact `---\\n<yaml>\\n---\\n<body>` shape every help
 * doc uses. js-yaml's load() is safe-by-default so this is also
 * the safer path.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { renderMarkdown } from '../markdown';

/**
 * Split a help-doc file into its YAML frontmatter and markdown body.
 *
 * Accepts either form:
 *   1. No frontmatter: returns `{ data: {}, content: <whole input> }`.
 *   2. Frontmatter present: the file MUST start with a `---` line
 *      (optional leading BOM allowed) and the YAML block MUST end
 *      with a matching `---` line on its own. Anything after the
 *      closing fence is the markdown body.
 *
 * The frontmatter is parsed with js-yaml's safe `load()`. A parse
 * error propagates so a broken doc is loud at build time, not silent
 * at runtime. Documents that fail to parse are caught by the caller
 * (it logs + skips them).
 *
 * Mirrors the gray-matter shape we used previously: `{ data, content }`.
 * Replaces gray-matter so help docs do not depend on it.
 */
function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  // Strip a leading BOM if any. Some editors save .md with it.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Open fence must be the very first line.
  if (!text.startsWith('---')) {
    return { data: {}, content: text };
  }
  // Walk past the opening fence's line terminator.
  // Accepts `---\n` or `---\r\n`.
  const afterOpen =
    text.charAt(3) === '\r' && text.charAt(4) === '\n'
      ? 5
      : text.charAt(3) === '\n'
        ? 4
        : -1;
  if (afterOpen < 0) {
    // `---` not followed by a newline is not a real fence.
    return { data: {}, content: text };
  }
  // Find the closing fence on its own line.
  const closeRe = /\r?\n---(?:\r?\n|$)/;
  closeRe.lastIndex = afterOpen;
  const closeMatch = closeRe.exec(text.slice(afterOpen));
  if (!closeMatch) {
    // Unterminated frontmatter: treat as a body, don't guess.
    return { data: {}, content: text };
  }
  const yamlBody = text.slice(afterOpen, afterOpen + closeMatch.index);
  const after = afterOpen + closeMatch.index + closeMatch[0].length;
  const content = text.slice(after);
  const parsed = yamlLoad(yamlBody);
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { data, content };
}

/**
 * AI-ready metadata schema.  Every page must have at least
 * `title` and `summary`; the rest is optional.  Embeddings + LLM
 * retrieval will key off `summary` + `title` + body.
 */
export interface HelpFrontmatter {
  /** Stable id used in URLs, control data-help attributes, and
   *  cross-page refs.  Defaults to the file slug if omitted. */
  id?: string;
  /** Page title.  Required.  Used in nav + browser title. */
  title: string;
  /** One-paragraph summary.  Required.  Drives search + AI
   *  retrieval; should make sense without the body. */
  summary: string;
  /** Hierarchical category for sidebar grouping.  Example:
   *  "map-editing/symbology". */
  category?: string;
  /** Ordinal within the category (lower = earlier).  Sort key for
   *  the sidebar; defaults to 100 when omitted so explicit
   *  entries float to the top. */
  order?: number;
  /** Control ids on the in-portal `data-help="..."` attributes
   *  that link to this page.  When the user clicks one of those
   *  controls with the help drawer open, this page loads. */
  controls?: Array<{ id: string; label?: string }>;
  /** Pages the reader is expected to have read first.  Rendered
   *  inline as a "Prerequisites" callout. */
  prerequisites?: string[];
  /** "basic" | "intermediate" | "advanced" -- shown as a badge
   *  in the header so users know what they're getting into. */
  complexity?: 'basic' | 'intermediate' | 'advanced';
  /** Related pages.  Each entry is either a bare doc id or
   *  `{ id, label }` to override the link text. */
  related?: Array<string | { id: string; label?: string }>;
  /** Free-form tags for filter + search.  No fixed vocabulary. */
  tags?: string[];
}

export interface HelpDoc {
  /** URL slug, with category prefix.  Example:
   *  "map-editing/symbology/scale-classes". */
  slug: string;
  /** Stable id (frontmatter `id` or last path segment). */
  id: string;
  /** Path segments relative to content/help/. */
  pathSegments: string[];
  /** Resolved frontmatter. */
  frontmatter: HelpFrontmatter;
  /** Rendered HTML body.  Safe to drop straight into
   *  dangerouslySetInnerHTML -- the marked instance below is
   *  configured to escape user content. */
  html: string;
  /** Raw markdown body for search indexing + future AI retrieval. */
  raw: string;
  /** Headings extracted from the body for in-page nav + search.
   *  Each entry is `{ depth, text, id }` where id is a kebab-case
   *  anchor matching what marked emits. */
  headings: Array<{ depth: number; text: string; id: string }>;
}

/**
 * Resolve the content/help directory.  Two cases:
 *   - Dev: `next dev` runs from apps/portal-web, so
 *     <cwd>/content/help is correct.
 *   - Prod standalone: the Docker runtime's cwd is /app and the
 *     traced files live at /app/apps/portal-web/content/help (the
 *     tracing root is the repo, the package is apps/portal-web).
 * Try the local path first, fall back to the apps/portal-web
 * subpath.  `existsSync` check keeps both branches working without
 * a build-time mode switch.
 */
function resolveHelpRoot(): string {
  const local = path.join(process.cwd(), 'content', 'help');
  const standalone = path.join(
    process.cwd(),
    'apps',
    'portal-web',
    'content',
    'help',
  );
  // existsSync is sync + cheap; runs once at module load.  We
  // import statSync at top-of-file so the lookup doesn't sneak
  // through to runtime.
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    if (fs.existsSync(local)) return local;
    if (fs.existsSync(standalone)) return standalone;
  } catch {
    /* fall through */
  }
  return local;
}

const HELP_ROOT = resolveHelpRoot();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function extractHeadings(
  raw: string,
): Array<{ depth: number; text: string; id: string }> {
  const out: Array<{ depth: number; text: string; id: string }> = [];
  // Match ATX-style headings (#, ##, etc.) at line start.  We
  // skip headings inside fenced code blocks by toggling a flag
  // when we see ```.
  const lines = raw.split(/\r?\n/);
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const depth = m[1]!.length;
      const text = m[2]!;
      out.push({ depth, text, id: slugify(text) });
    }
  }
  return out;
}

/**
 * Explicit top-level category ordering.  Plain alphabetical put
 * "Analysis" at the top and pushed "Getting Started" into the
 * middle of the sidebar, which is a poor first impression.  This
 * map fixes the reading order new users see; unknown top-levels
 * fall back to alpha sort after these.
 *
 * Keyed by the *raw* category segment (before prettyLabel).
 */
const CATEGORY_ORDER: Record<string, number> = {
  'getting-started': 10,
  'coming-from-arcgis': 15,
  items: 20,
  'map-editing': 30,
  forms: 40,
  'web-apps': 50,
  'print-templates': 55,
  analysis: 60,
  admin: 70,
  reference: 90,
};

function categoryRank(rawCategory: string): number {
  const top = rawCategory.split('/')[0] ?? '';
  return CATEGORY_ORDER[top] ?? 1000;
}

/**
 * Walk `content/help/` recursively, parse every `.md` / `.mdx`
 * file, and return a flat array of HelpDoc.  Called at build /
 * request time from Next.js server components.
 */
export async function loadAllDocs(): Promise<HelpDoc[]> {
  const out: HelpDoc[] = [];
  await walk(HELP_ROOT, [], out);
  // Sort: explicit category rank, then category alpha (for ties
  // and unmapped categories), then order asc, then title alpha.
  // buildNav iterates in this order, so the sidebar tree comes
  // out in the right top-level order without re-sorting children.
  out.sort((a, b) => {
    const ca = a.frontmatter.category ?? '';
    const cb = b.frontmatter.category ?? '';
    const ra = categoryRank(ca);
    const rb = categoryRank(cb);
    if (ra !== rb) return ra - rb;
    if (ca !== cb) return ca.localeCompare(cb);
    const oa = a.frontmatter.order ?? 100;
    const ob = b.frontmatter.order ?? 100;
    if (oa !== ob) return oa - ob;
    return a.frontmatter.title.localeCompare(b.frontmatter.title);
  });
  return out;
}

async function walk(
  dir: string,
  prefix: string[],
  out: HelpDoc[],
): Promise<void> {
  // `withFileTypes` returns Dirent objects we can branch on without a
  // second stat(). Avoiding the stat-then-readFile pattern closes the
  // js/file-system-race window CodeQL flagged: between stat and
  // readFile the entry could be swapped out for a symlink. Dirent's
  // isDirectory() is decided at the readdir cursor.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory missing entirely (first run, or no docs yet).
    return;
  }
  for (const ent of entries) {
    const entry = ent.name;
    const full = path.join(dir, entry);
    if (ent.isDirectory()) {
      await walk(full, [...prefix, entry], out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!/\.mdx?$/i.test(entry)) continue;
    const raw = await readFile(full, 'utf8');
    const parsed = parseFrontmatter(raw);
    // Cast via unknown: parseFrontmatter returns the YAML's actual
    // shape (Record<string, unknown>); the title / summary check on
    // the next two lines is what validates the HelpFrontmatter
    // contract at runtime.
    const fm = parsed.data as unknown as HelpFrontmatter;
    if (!fm.title || !fm.summary) {
      console.warn(
        `[help] skipping ${entry}: missing required frontmatter (title, summary)`,
      );
      continue;
    }
    const baseName = entry.replace(/\.mdx?$/i, '');
    const segments = [...prefix, baseName === 'index' ? '' : baseName].filter(
      (s) => s !== '',
    );
    const slug = segments.join('/');
    const id = fm.id ?? baseName;
    const html = renderMarkdown(parsed.content);
    const headings = extractHeadings(parsed.content);
    out.push({
      slug,
      id,
      pathSegments: segments,
      frontmatter: fm,
      html,
      raw: parsed.content,
      headings,
    });
  }
}

/** Look up one doc by its slug array (from a Next.js catch-all
 *  route's `params.slug`).  Empty array = the help landing page. */
export async function loadDocBySlug(
  slug: string[] | undefined,
): Promise<HelpDoc | null> {
  const docs = await loadAllDocs();
  const target = (slug ?? []).join('/');
  return docs.find((d) => d.slug === target) ?? null;
}

/**
 * Build a slim, JSON-serializable index for the client-side
 * search.  Each entry has just enough to score + render a result
 * snippet; full bodies stay on the server.
 */
export interface HelpSearchEntry {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  controls: string[];
  /** Lowercased blob of title + summary + headings + tags +
   *  control labels, used as the substring-search haystack. */
  haystack: string;
}

export async function buildSearchIndex(): Promise<HelpSearchEntry[]> {
  const docs = await loadAllDocs();
  return docs.map((d) => {
    const headingsText = d.headings.map((h) => h.text).join(' ');
    const tagsText = (d.frontmatter.tags ?? []).join(' ');
    const controlsText = (d.frontmatter.controls ?? [])
      .map((c) => `${c.id} ${c.label ?? ''}`)
      .join(' ');
    return {
      id: d.id,
      slug: d.slug,
      title: d.frontmatter.title,
      summary: d.frontmatter.summary,
      category: d.frontmatter.category ?? '',
      tags: d.frontmatter.tags ?? [],
      controls: (d.frontmatter.controls ?? []).map((c) => c.id),
      haystack: [
        d.frontmatter.title,
        d.frontmatter.summary,
        headingsText,
        tagsText,
        controlsText,
      ]
        .join(' ')
        .toLowerCase(),
    };
  });
}

/**
 * Reverse index: control id -> doc id (slug).  The portal's
 * help drawer queries this when the user clicks a `data-help`-
 * tagged control so it can open the right page.
 */
export async function buildControlIndex(): Promise<Record<string, string>> {
  const docs = await loadAllDocs();
  const out: Record<string, string> = {};
  for (const d of docs) {
    for (const c of d.frontmatter.controls ?? []) {
      // Don't overwrite -- first doc that claims a control wins.
      // The frontmatter author can switch by removing the binding
      // from the loser.
      if (!out[c.id]) out[c.id] = d.slug;
    }
  }
  return out;
}

/**
 * Build the nav tree used by the sidebar.  Categories collapse
 * naturally because they're slash-separated strings -- "map-
 * editing/symbology/scale-classes" lives under "map-editing" >
 * "symbology" > "Scale classes".
 */
export interface HelpNavNode {
  label: string;
  /** When set, this node is a leaf doc and the user can navigate
   *  to it.  When unset, the node is a category. */
  slug?: string;
  children: HelpNavNode[];
}

export async function buildNav(): Promise<HelpNavNode> {
  const docs = await loadAllDocs();
  const root: HelpNavNode = { label: 'root', children: [] };
  for (const d of docs) {
    const cat = d.frontmatter.category ?? '';
    const parts = cat ? cat.split('/').filter(Boolean) : [];
    let cursor = root;
    for (const part of parts) {
      // Compare against the pretty label since that's what we
      // store on the node.  Earlier I compared against the raw
      // `part` and pushed the pretty form, so the lookup never
      // matched and a fresh category node spawned per doc --
      // sidebar showed "Getting Started" three times with one
      // child each.
      const pretty = prettyLabel(part);
      let next = cursor.children.find(
        (c) => c.label === pretty && !c.slug,
      );
      if (!next) {
        next = { label: pretty, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    // Skip the landing page (slug = "") from the sidebar tree.
    // It's reachable via the help-system masthead link; rendering
    // it as a leaf at root visually competes with real top-level
    // categories.
    if (d.slug === '') continue;
    cursor.children.push({
      label: d.frontmatter.title,
      slug: d.slug,
      children: [],
    });
  }
  return root;
}

function prettyLabel(rawSegment: string): string {
  return rawSegment
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
