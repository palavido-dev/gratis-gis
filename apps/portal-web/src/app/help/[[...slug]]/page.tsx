// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  buildNav,
  loadDocBySlug,
  loadAllDocs,
  CATEGORY_ORDER,
  categoryRank,
  prettyCategoryLabel,
} from '@/lib/help/content';
import { HelpSearchBox } from './search-box';
import { HelpSidebarNav } from './sidebar-nav';

/**
 * Per-doc <title> + meta description (#SEO).  Without this every
 * /help/* URL ships with the root layout's generic "GratisGIS"
 * title, which makes Google show the same snippet for fifty
 * different pages and tanks click-through.  Reads the same
 * frontmatter the page body uses, so authoring one doc covers
 * both rendering and SEO.
 */
export async function generateMetadata(
  props: { params: Promise<{ slug?: string[] }> },
): Promise<Metadata> {
  const params = await props.params;
  if (!params.slug || params.slug.length === 0) {
    return {
      title: 'Help',
      description:
        'GratisGIS user guide: getting started, item types, map editing, forms, app builder, admin, and analysis tools.',
      alternates: { canonical: '/help' },
    };
  }
  const doc = await loadDocBySlug(params.slug);
  if (!doc) {
    return {
      title: 'Help',
      description: 'GratisGIS user guide.',
    };
  }
  const slugPath = params.slug.join('/');
  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.summary,
    alternates: { canonical: `/help/${slugPath}` },
    openGraph: {
      title: doc.frontmatter.title,
      description: doc.frontmatter.summary,
      type: 'article',
      url: `/help/${slugPath}`,
    },
  };
}

/**
 * Help system entry point (#118).  Catch-all route under /help
 * that renders either the landing page (when no slug is supplied)
 * or a specific doc.  Server component: docs load + render at
 * request time so frontmatter + body changes hot-reload in dev
 * without a build.  In prod Next.js caches the read at the static
 * generation pass; manual content edits trigger a redeploy.
 *
 * The sidebar nav and the search box are both client components
 * so they can stay sticky / interactive without re-running the
 * server query on every keystroke.
 */
export default async function HelpPage(
  props: {
    params: Promise<{ slug?: string[] }>;
  }
) {
  const params = await props.params;
  const nav = await buildNav();
  const all = await loadAllDocs();
  const indexLite = all.map((d) => ({
    id: d.id,
    slug: d.slug,
    title: d.frontmatter.title,
    summary: d.frontmatter.summary,
    category: d.frontmatter.category ?? '',
    controls: (d.frontmatter.controls ?? []).map((c) => c.id),
    haystack: [
      d.frontmatter.title,
      d.frontmatter.summary,
      (d.frontmatter.tags ?? []).join(' '),
      (d.frontmatter.controls ?? []).map((c) => c.id).join(' '),
    ]
      .join(' ')
      .toLowerCase(),
  }));

  const doc =
    !params.slug || params.slug.length === 0
      ? null
      : await loadDocBySlug(params.slug);

  if (params.slug && params.slug.length > 0 && !doc) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6">
      <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 overflow-y-auto md:block">
        <HelpSearchBox index={indexLite} />
        <nav className="mt-4">
          <HelpSidebarNav nav={nav} activeSlug={doc?.slug ?? ''} />
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        {doc ? (
          <DocView doc={doc} all={all} />
        ) : (
          <Landing all={all} />
        )}
      </main>
    </div>
  );
}

function DocView({
  doc,
  all,
}: {
  doc: NonNullable<Awaited<ReturnType<typeof loadDocBySlug>>>;
  all: Awaited<ReturnType<typeof loadAllDocs>>;
}) {
  const fm = doc.frontmatter;
  // Resolve `related` entries (mix of bare ids and {id,label}).
  const related = (fm.related ?? []).map((r) => {
    const id = typeof r === 'string' ? r : r.id;
    const match = all.find((d) => d.id === id || d.slug === id);
    return {
      label:
        typeof r === 'object' && r.label
          ? r.label
          : match?.frontmatter.title ?? id,
      slug: match?.slug ?? id,
    };
  });
  return (
    <article className="prose prose-sm max-w-3xl [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.95em] [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-ink-0 [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-ink-0 [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-ink-0 [&_li]:my-1 [&_li]:text-ink-1 [&_ol]:my-3 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:my-3 [&_p]:text-ink-1 [&_pre]:my-3 [&_pre]:rounded [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:text-xs [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_td]:text-sm [&_th]:border [&_th]:border-border [&_th]:bg-surface-1 [&_th]:p-1.5 [&_th]:text-left [&_th]:text-sm [&_th]:font-semibold [&_ul]:my-3 [&_ul]:ml-5 [&_ul]:list-disc">
      <header className="mb-4 border-b border-border pb-3">
        <h1 className="mb-1! mt-0!">{fm.title}</h1>
        <p className="my-0! text-sm text-muted">{fm.summary}</p>
        {fm.complexity ? (
          <span
            className={`mt-2 inline-block rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${
              fm.complexity === 'basic'
                ? 'bg-success/15 text-success'
                : fm.complexity === 'intermediate'
                  ? 'bg-warn/15 text-warn'
                  : 'bg-danger/15 text-danger'
            }`}
          >
            {fm.complexity}
          </span>
        ) : null}
      </header>
      {fm.prerequisites && fm.prerequisites.length > 0 ? (
        <div className="mb-4 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <strong className="font-semibold">Before you start:</strong>
          <ul className="mt-1 ml-5 list-disc">
            {fm.prerequisites.map((p) => {
              const match = all.find((d) => d.id === p || d.slug === p);
              return (
                <li key={p}>
                  {match ? (
                    <Link href={`/help/${match.slug}`}>
                      {match.frontmatter.title}
                    </Link>
                  ) : (
                    p
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div
        // Body is server-rendered from trusted in-repo markdown,
        // not user input.  Our vendored renderer HTML-escapes
        // everything that isn't part of the supported subset, so
        // the output is safe to inject.
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
      {related.length > 0 ? (
        <footer className="mt-8 border-t border-border pt-4">
          <h2 className="mt-0! mb-2! text-sm! font-semibold! text-muted!">
            See also
          </h2>
          <ul className="my-0!">
            {related.map((r) => (
              <li key={r.slug}>
                <Link href={`/help/${r.slug}`}>{r.label}</Link>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}

/** Task-shaped entry points for the help landing. One job each. */
const LANDING_PATHS: Array<{
  title: string;
  blurb: string;
  href: string;
}> = [
  {
    title: 'New here',
    blurb: 'What GratisGIS is, your first map, and how sharing works.',
    href: '/help/getting-started/what-is-gratisgis',
  },
  {
    title: 'Publish data & maps',
    blurb: 'Upload a CSV or layer, style it, set the viewport, share it.',
    href: '/help/getting-started/uploading-csv',
  },
  {
    title: 'Collect in the field',
    blurb: 'Forms, the form designer, and offline data collection.',
    href: '/help/forms/form-designer',
  },
  {
    title: 'Analyze',
    blurb: 'Buffer, clip, dissolve, and the other derived-layer steps.',
    href: '/help/analysis/buffer',
  },
  {
    title: 'Build apps & print',
    blurb: 'Custom web apps, widgets, themes, and print templates.',
    href: '/help/web-apps/custom-app',
  },
  {
    title: 'Automate',
    blurb: 'API keys, the Python client, scripts, HTTP API, MCP.',
    href: '/help/reference/api-keys',
  },
  {
    title: 'Coming from ArcGIS',
    blurb: 'Feature services, web maps, Survey123, and terminology.',
    href: '/help/coming-from-arcgis',
  },
  {
    title: 'Admin',
    blurb: 'Users, branding, backups, housekeeping, sign-in.',
    href: '/help/admin/organization-settings',
  },
];

function Landing({
  all,
}: {
  all: Awaited<ReturnType<typeof loadAllDocs>>;
}) {
  // Group by full category path so Analysis > Proximity stays intact.
  type Doc = (typeof all)[number];
  const byCategory = new Map<string, Doc[]>();
  for (const d of all) {
    if (d.slug === '') continue;
    const cat = d.frontmatter.category ?? '';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(d);
  }
  const categories = Array.from(byCategory.entries()).sort(([a], [b]) => {
    const ra = categoryRank(a);
    const rb = categoryRank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  // Collapse into top-level sections for the directory below the hub.
  const topSections = new Map<
    string,
    Array<{ sub: string; docs: Doc[] }>
  >();
  for (const [cat, docs] of categories) {
    const parts = cat.split('/').filter(Boolean);
    const top = parts[0] ?? 'other';
    const sub = parts.slice(1).join('/') || '';
    if (!topSections.has(top)) topSections.set(top, []);
    topSections.get(top)!.push({ sub, docs });
  }
  const orderedTops = Array.from(topSections.keys()).sort((a, b) => {
    const ra = CATEGORY_ORDER[a] ?? 1000;
    const rb = CATEGORY_ORDER[b] ?? 1000;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  return (
    <article className="max-w-3xl">
      <h1 className="mb-2 text-2xl font-bold text-ink-0">Help</h1>
      <p className="mb-6 text-sm text-muted">
        One concept per page. Start from a task below, browse the sidebar
        by area, or search. Screenshots sit next to every UI step.
      </p>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Start here
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {LANDING_PATHS.map((p) => (
            <li key={p.href}>
              <Link
                href={p.href}
                className="block h-full rounded-md border border-border bg-surface-1 px-3 py-3 transition-colors hover:border-accent hover:bg-accent/5"
              >
                <span className="block text-sm font-semibold text-ink-0">
                  {p.title}
                </span>
                <span className="mt-1 block text-xs text-muted">{p.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Browse by area
        </h2>
        {orderedTops.map((top) => {
          const groups = topSections.get(top) ?? [];
          return (
            <div key={top} className="mb-8">
              <h3 className="mb-2 text-base font-semibold text-ink-0">
                {prettyCategoryLabel(top)}
              </h3>
              {groups.map(({ sub, docs }) => (
                <div key={`${top}/${sub}`} className="mb-4">
                  {sub ? (
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      {sub
                        .split('/')
                        .map((s) => prettyCategoryLabel(s))
                        .join(' / ')}
                    </h4>
                  ) : null}
                  <ul className="space-y-1">
                    {docs.map((d) => (
                      <li key={d.slug}>
                        <Link
                          href={`/help/${d.slug}`}
                          className="text-sm text-accent hover:underline"
                        >
                          {d.frontmatter.title}
                        </Link>
                        <span className="ml-2 text-xs text-muted">
                          {d.frontmatter.summary}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </article>
  );
}
