// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import {
  Bell,
  Brush,
  Database,
  Github,
  Globe,
  Info,
  LogIn,
  MessageCircle,
  MessageSquarePlus,
  RefreshCw,
  Smartphone,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import type { ItemType } from '@gratis-gis/shared-types';
import {
  getItemHref,
  getItemTypeIcon,
  getItemTypeTileClasses,
  hasRuntime,
} from '@/lib/item-type-icon';
import { portalUrl } from '@/lib/portal-url';
import type { WhatsNewEntry } from '@/lib/whats-new';

/**
 * Public landing page for unauthenticated visitors. Renders outside
 * the main app-shell (see AppShell's no-session branch) so there is
 * no sidebar, no "Recently deleted", no nav hinting at content the
 * visitor can't see. The admin controls what this page looks like
 * through five knobs on the Organization row:
 *
 *   1. landingTitle        - falls back to org.name
 *   2. landingSubtitle     - optional
 *   3. landingHeroImageUrl - optional; hero band is a muted fill when unset
 *   4. landingShowPublicItems - toggle the content grid off for a clean
 *      logo + sign-in page (some orgs want this)
 *   5. landingFeaturedItemIds - ordered list shown first in the grid;
 *      empty falls back to all public items newest-first
 *
 * Data comes from GET /api/portal/public/landing which proxies to
 * the portal-api's unauthenticated /public/landing endpoint.
 */
interface LandingData {
  org: {
    slug: string;
    name: string;
    title: string;
    subtitle: string | null;
    heroImageUrl: string | null;
    showPublicItems: boolean;
  };
  items: Array<{
    id: string;
    title: string;
    description: string | null;
    type: ItemType;
    thumbnailUrl: string | null;
    updatedAt: string;
    tags: string[];
    /** Open-data license URL.  Surfaced in the landing's Dataset
     *  JSON-LD so Google Rich Results / data.gov-style aggregators
     *  see a license string on every dataset.  Null when the
     *  author didn't pick one; the JSON-LD omits the field
     *  entirely in that case. */
    license?: string | null;
    // Item data payload (added by the public/landing API). Only
    // used by getItemHref / hasRuntime to route templated web_apps
    // to their runtime URL; otherwise unread by the landing.
    data?: unknown;
  }>;
}

interface Props {
  data: LandingData;
  /**
   * #255: when true, render the open-source project section even
   * if NEXT_PUBLIC_PROJECT_LANDING isn't set. Used by the page-
   * level ?preview=project override so an admin can layout-check
   * the public alpha view without flipping the env flag.
   */
  forceProjectSection?: boolean;
  /**
   * #274: render an "Open my items" CTA instead of "Sign in" when
   * the visitor already has a session. Lets the / route be
   * consistently public-facing for everyone (including authenticated
   * users hitting the apex domain) while still giving signed-in
   * folks a clear path back into their workspace. Authenticated
   * users still see all the public marketing/items copy -- they
   * just don't get prompted to sign in again.
   */
  isAuthenticated?: boolean;
  /**
   * Recent user-visible updates parsed from
   * docs/changelog/user-visible.md.  Empty or omitted to suppress
   * the "What's new" card (e.g. on first deploy before any entries
   * exist).
   */
  whatsNew?: WhatsNewEntry[];
}

export function PublicLanding({
  data,
  forceProjectSection,
  isAuthenticated,
  whatsNew,
}: Props) {
  const { org, items: rawItems } = data;
  // Filter to items that actually have an anonymous-accessible
  // surface so a visitor never gets bounced to Keycloak from the
  // landing page. Maps, raw data layers, basemaps etc. don't have
  // an anonymous detail page yet (#76); promoting them on the
  // landing creates a "click here for public content, oh wait
  // please sign in" trap that real testers have hit and called out.
  // Until #76 ships anon detail surfaces for those item types, hide
  // them rather than advertising a broken click path. The item is
  // still publicly accessible via the API for anyone who already
  // has the id; this filter is a UX-on-the-landing decision, not a
  // sharing decision.
  const items = rawItems.filter((it) =>
    hasRuntime(it as Parameters<typeof hasRuntime>[0]),
  );
  const ctaHref = isAuthenticated ? '/items' : '/signin';
  const ctaLabel = isAuthenticated ? 'Open my items' : 'Sign in';

  return (
    <div className="flex min-h-screen flex-col">
      {/* #274: TopBar duplicates the org wordmark + an auth CTA.
          For authenticated visitors the AppShell's left rail and
          top bar already cover both, so showing the public TopBar
          here renders a redundant "Sign in" button next to the
          shell's signed-in badge. Hide it when isAuthenticated;
          unauthenticated visitors still see it as their only
          surface for the org name + sign-in entry. */}
      {!isAuthenticated ? <TopBar orgName={org.name} /> : null}

      {/* #141: public-testing banner. Rendered when the deploy is
          in public-testing mode (NEXT_PUBLIC_PUBLIC_TESTING=1) so
          visitors see test credentials + the daily-reset window
          before anything else. Honest about the state of the
          instance: nothing they do persists past the next reset. */}
      {process.env.NEXT_PUBLIC_PUBLIC_TESTING === '1' ? (
        <TestingBanner />
      ) : null}

      {/* Schema.org JSON-LD so search engines / open-data
          aggregators can index this page's public items. Server
          rendered (this is a server component) so the structured
          data is in the initial HTML response. See #66. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildLandingJsonLd(data), null, 0),
        }}
      />

      <Hero
        title={org.title}
        subtitle={org.subtitle}
        heroImageUrl={org.heroImageUrl}
      />

      {/* #255: open-source project section. Renders when the
          deployment opts in via NEXT_PUBLIC_PROJECT_LANDING=1, OR
          when the parent forces it via the forceProjectSection
          prop (?preview=project URL override). Per-tenant
          deployments leave both off so their landing reads as a
          tenant page (datasets + sign-in), not a "what is GratisGIS"
          marketing page. The canonical gratisgis.org deployment
          flips the flag on for the public alpha. */}
      {process.env.NEXT_PUBLIC_PROJECT_LANDING === '1' ||
      forceProjectSection ? (
        <ProjectAboutSection />
      ) : null}

      {whatsNew && whatsNew.length > 0 ? (
        <WhatsNewSection entries={whatsNew} />
      ) : null}

      {org.showPublicItems ? (
        <section className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-ink-0">
              Explore public content
            </h2>
            <p className="mt-1 text-sm text-muted">
              Datasets, maps, and apps {org.name} has shared publicly.
            </p>
          </div>

          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface-1 p-10 text-center">
              <p className="text-sm text-muted">
                Nothing has been shared publicly yet. If you have a
                portal account, sign in to see content shared with you.
              </p>
              <Link
                href={ctaHref}
                className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
              >
                <LogIn className="h-4 w-4" />
                {ctaLabel}
              </Link>
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        // Logo-only mode: no grid, just a centered sign-in block so
        // the page has something the user can actually do.
        <section className="flex flex-1 items-center justify-center px-6 py-12">
          <Link
            href={ctaHref}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-accent px-5 text-base font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <LogIn className="h-5 w-5" />
            {ctaLabel}
          </Link>
        </section>
      )}

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        Powered by GratisGIS &middot;{' '}
        <Link href="/why" className="underline hover:text-ink-0">
          Why GratisGIS
        </Link>{' '}
        &middot;{' '}
        <Link href="/credits" className="underline hover:text-ink-0">
          Built on
        </Link>
      </footer>
    </div>
  );
}

/**
 * "What's new" card on the landing page.  Driven by entries parsed
 * from docs/changelog/user-visible.md at server-render time.  The
 * source is plain-English on purpose -- if an entry reads like a
 * release note ("Refactored the SymbolService") it doesn't belong
 * here.  See docs/changelog/user-visible.md for the format and the
 * tone we keep.
 */
function WhatsNewSection({ entries }: { entries: WhatsNewEntry[] }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-10">
      <div className="rounded-lg border border-border bg-surface-1 p-6 shadow-card">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight text-ink-0">
            What&apos;s new
          </h2>
        </div>
        <ul className="space-y-4">
          {entries.map((e) => (
            <li
              key={`${e.date}-${e.name}`}
              className="border-l-2 border-accent/40 pl-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <time
                  dateTime={e.date}
                  className="font-mono text-2xs uppercase tracking-wide text-muted"
                >
                  {formatChangelogDate(e.date)}
                </time>
                <span className="text-sm font-medium text-ink-0">
                  {e.name}
                </span>
              </div>
              <p className="mt-0.5 text-sm leading-snug text-muted">
                {e.description}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Render the YYYY-MM-DD heading date in a friendlier short form
 * (e.g. "May 24, 2026").  We do this in-place because the landing
 * page is a server component; bringing in a date-formatting library
 * for one line would be overkill.  Falls back to the raw string if
 * the input doesn't parse, so a malformed entry still renders.
 */
function formatChangelogDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * #255: open-source project marketing section. Sits below the
 * Hero on canonical gratisgis.org-style deployments (gated by
 * NEXT_PUBLIC_PROJECT_LANDING=1) so visitors who hit the apex
 * domain see "what is GratisGIS" before "what's in this tenant".
 *
 * Three columns of value props, a row of CTAs (GitHub repo, file
 * an issue, view the docs), and a feedback affordance that
 * pre-fills a GitHub issue. The pre-fill keeps the surface zero-
 * backend: GitHub does the auth + the routing; we just hand them
 * a link with title + body params. If/when we want a smoother
 * unauthenticated-feedback flow, swap the link for a backend
 * bridge endpoint (NEXT_PUBLIC_FEEDBACK_ENDPOINT or similar).
 */
function ProjectAboutSection() {
  // GitHub coordinates. Pulled from env so a fork can swap them
  // without code changes, with sensible defaults to the upstream
  // repo for the canonical deployment.
  const repo =
    process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'palavido-dev/gratis-gis';
  const repoUrl = `https://github.com/${repo}`;

  return (
    <section className="border-b border-border bg-surface-0 px-6 py-12">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-8 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Open source GIS portal
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-ink-0 sm:text-3xl">
            An open-source, self-hosted GIS portal
          </h2>
          <p className="mt-2 text-sm text-muted sm:text-base">
            GratisGIS is a portal for publishing datasets, web maps,
            forms, and dashboards on your own infrastructure. Built on
            open components (PostGIS, MapLibre, Keycloak). No license
            fees; your only cost is the hardware (or cloud bill) you
            choose to run it on.
          </p>
        </div>

        <ul className="mb-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureTile
            icon={Database}
            title="Your data, your hardware"
            body="PostGIS-backed datasets, web maps, and forms. Bring data in from shapefiles, GeoJSON, GDB, or any OGR-supported format."
          />
          <FeatureTile
            icon={Smartphone}
            title="Field-ready PWA"
            body="A data-collection app that installs to the home screen, works offline, and syncs when you're back online."
          />
          <FeatureTile
            icon={Globe}
            title="Standards-friendly + ArcGIS-friendly"
            body="OGC API Features, Tiles, Styles, and Records; CSW 2.0.2 catalog; Schema.org JSON-LD; WMS / WFS service references; plus Esri WebMap JSON export so portal maps open in ArcGIS Pro, ArcGIS Online, QGIS, and kepler.gl."
          />
          <FeatureTile
            icon={Wrench}
            title="Built for self-hosting"
            body="Docker compose, single-command deploy. Runs on a $20/month VPS or your existing infrastructure. No SaaS lock-in."
          />
        </ul>

        {/* #255: section that follows the four positioning tiles
            above with concrete operational features the portal ships
            with by default (housekeeping, sync, notifications, share
            granularity). Originally framed as "problems we set out to
            fix on commercial portals"; #143 reframed away from the
            counter-positioning so the section now reads as "this is
            what GratisGIS gives you out of the box." */}
        <div className="mb-10 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Built in, not bolted on
          </p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-ink-0 sm:text-2xl">
            Operational features the portal ships with
          </h3>
        </div>
        <ul className="mb-12 grid gap-6 sm:grid-cols-2">
          <FeatureTile
            icon={Brush}
            title="Housekeeping that runs itself"
            body="Stale items get flagged. Inactive users get auto-disabled. Expiring shares trigger warnings. Spatial extents get recomputed on a schedule. Admins get a dashboard, not a backlog."
          />
          <FeatureTile
            icon={RefreshCw}
            title="Sync that doesn't lose your work"
            body="Offline edits go to a per-edit queue with isolated retries. A bad row doesn't poison the rest. Schema changes notify every device that has cached the deployment so the field crew rebuilds before they next sync."
          />
          <FeatureTile
            icon={Bell}
            title="Email notifications you actually control"
            body="Built-in templates for shares, expirations, schema changes, form submissions, and field captures. Org admins customize the copy through a guided editor with click-to-insert variables. Routed through one SMTP, not a sprawl of webhooks."
          />
          <FeatureTile
            icon={Users}
            title="Sharing granularity that makes sense"
            body="Share an item with a user, a group, or a folder. Folder shares cascade to every item in the folder. Per-share row scope ('all' vs 'own') and geographic clip (polygon) layer on top. View / download / edit / admin tiers, not a single 'shared' bit."
          />
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <Github className="h-4 w-4" />
            View on GitHub
          </a>
          {/* #146: Send feedback goes to the in-portal /feedback
              form rather than GitHub Issues. The whole point of
              the form is that a tester without a GitHub account
              can still leave a note. The form's "Prefer GitHub?"
              section links out to Issues + Discussions for users
              who want the richer surface. */}
          <Link
            href="/feedback"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <MessageSquarePlus className="h-4 w-4" />
            Send feedback
          </Link>
          {/* #141: Discussions link for longer-form conversations
              that aren't bug reports. Requires a GitHub account
              (anonymous Discussions doesn't exist), so the
              in-portal feedback form sits in the primary slot. */}
          <a
            href={`${repoUrl}/discussions`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <MessageCircle className="h-4 w-4" />
            Discussions
          </a>
          <span className="text-xs text-muted sm:ml-2">
            Send feedback goes to the maintainer&apos;s inbox; no
            account required. Discussions is the GitHub place for
            longer threads.
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * #141: Public-testing-mode banner. Rendered at the very top of
 * the landing page (above the Hero) when the deploy sets
 * NEXT_PUBLIC_PUBLIC_TESTING=1. Spells out:
 *
 *   - The instance is a test environment, not a production
 *     deployment (so testers don't expect their data to persist).
 *   - The three documented test users and their passwords
 *     (matches what seed-test-users.sh provisions).
 *   - The daily reset window (matches what
 *     gg-reset-demo.timer fires at).
 *
 * Tone is informational, not alarming. Amber-styled because
 * "heads up, this is a sandbox" reads better in amber than the
 * danger red.
 */
function TestingBanner() {
  return (
    <div className="border-b border-warn/40 bg-warn/10 px-6 py-3 text-sm">
      <div className="mx-auto flex w-full max-w-5xl items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="flex-1 text-warn">
          <p className="font-medium">
            This is a public test instance. Resets to a curated
            golden state every day at 04:00 UTC.
          </p>
          <p className="mt-1 leading-relaxed">
            Sign in with{' '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              tester-admin
            </code>
            {' / '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              Admin123!
            </code>
            ,{' '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              tester-contributor
            </code>
            {' / '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              Contributor123!
            </code>
            , or{' '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              tester-viewer
            </code>
            {' / '}
            <code className="rounded bg-warn/15 px-1 font-mono text-xs">
              Viewer123!
            </code>
            . Items, users, and edits you create vanish at the next
            reset. Feedback is welcome via the GitHub Issues link
            below.
          </p>
          <p className="mt-1 leading-relaxed">
            New here? Open the{' '}
            <span className="font-medium">Sample: Randolph County</span>{' '}
            folder after signing in: a complete demo workspace with
            styled layers, a map, a form with responses, a field
            survey, and public apps, all built on one small West
            Virginia county.
          </p>
        </div>
      </div>
    </div>
  );
}

function FeatureTile({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <li className="flex flex-col gap-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="text-sm font-semibold text-ink-0">{title}</h3>
      <p className="text-sm text-muted">{body}</p>
    </li>
  );
}

function TopBar({ orgName }: { orgName: string }) {
  // Same safe-area treatment as the AppShell top bar: viewport-fit=
  // cover (set in the root layout) puts the page under the iOS
  // status bar / dynamic island, so without an explicit inset the
  // GratisGIS wordmark and the Sign-in button render behind the
  // OS chrome on iPhones.
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
      <div className="flex items-center gap-2">
        <BrandMark size={26} />
        <span className="text-base font-semibold tracking-tight">
          {orgName}
        </span>
      </div>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Link>
    </header>
  );
}

function Hero({
  title,
  subtitle,
  heroImageUrl,
}: {
  title: string;
  subtitle: string | null;
  heroImageUrl: string | null;
}) {
  const bg = heroImageUrl
    ? { backgroundImage: `url(${heroImageUrl})` }
    : undefined;
  return (
    <section
      className={`relative flex min-h-[280px] items-center justify-center bg-surface-2 px-6 py-16 text-center ${
        heroImageUrl ? 'bg-cover bg-center' : ''
      }`}
      style={bg}
    >
      {heroImageUrl ? (
        // Soft overlay so the title reads cleanly over any hero
        // image. Purely cosmetic; no functional impact when no image
        // is set.
        <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      ) : null}
      <div className="relative z-[1] max-w-3xl">
        <h1
          className={`text-4xl font-semibold tracking-tight sm:text-5xl ${
            heroImageUrl ? 'text-white' : 'text-ink-0'
          }`}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            className={`mt-3 text-base ${
              heroImageUrl ? 'text-white/90' : 'text-muted'
            }`}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ItemCard({ item }: { item: LandingData['items'][number] }) {
  const Icon: LucideIcon = getItemTypeIcon(item.type);
  const tile = getItemTypeTileClasses(item.type);
  return (
    <li>
      <Link
        href={getItemHref(item)}
        // Open runnable items (viewer web_apps today, data_collection /
        // editor once their anonymous surfaces ship) in a new tab so
        // the landing page stays available for the visitor to keep
        // browsing. Non-runnable items currently still navigate
        // same-tab to /items/:id which redirects to sign-in -- those
        // shouldn't be on the landing yet (no public detail page),
        // and the parent grid filters them out.
        {...(hasRuntime(item)
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {})}
        className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-raised"
      >
        {item.thumbnailUrl ? (
          // Hosted thumbnail path: MinIO-backed, origin-safe.
          // 3:2 aspect matches the designer-baked SVG viewBox + the
          // shared ItemCard in packages/ui so the title band at the
          // bottom of a baked thumbnail isn't cropped off when the
          // card narrows. Previously this used `h-32 w-full
          // object-cover`, which forced a 128px height and cropped
          // the bottom of the image (where the title band sits) on
          // anything wider than ~190px.
          <div className="aspect-[3/2] w-full overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        ) : (
          <div
            className={`flex aspect-[3/2] w-full items-center justify-center ${tile}`}
          >
            <Icon className="h-10 w-10" />
          </div>
        )}
        <div className="flex flex-1 flex-col p-3">
          <p className="text-2xs uppercase tracking-wide text-muted">
            {item.type.replace(/_/g, ' ')}
          </p>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-ink-0">
            {item.title}
          </h3>
          {item.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted">
              {item.description}
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------
// Schema.org JSON-LD for the landing page (#66)
// ---------------------------------------------------------------

/**
 * Build a Schema.org `CollectionPage` whose `mainEntity` is an
 * `ItemList` of every public item rendered on the page. Datasets
 * (data_layer / arcgis_service / wms_service / wfs_service) get
 * `Dataset` typing so open-data aggregators recognise them; other
 * item types fall back to the generic `CreativeWork`. Output is a
 * single JSON-LD blob the page injects via a server-rendered
 * <script type="application/ld+json"> tag.
 *
 * The portal does not have public item detail pages today, so the
 * URLs point at /items/<id>. Once the public detail surface lands,
 * the same shape can be lifted onto each item's own page (one
 * Dataset per page) without regenerating the structure here.
 */
function buildLandingJsonLd(
  data: LandingData,
): Record<string, unknown> {
  const dataLayerLike = new Set<ItemType>([
    'data_layer',
    'arcgis_service',
    'wms_service',
    'wfs_service',
  ]);
  // Google Rich Results requires Dataset descriptions in the 50-5000
  // character range.  Short author descriptions ("Statewide parcel
  // data") fail validation as "Invalid string length" and disqualify
  // the whole Dataset entry from rich-result eligibility. Pad with a
  // synthesized tail that adds publisher context so the result is
  // still meaningful, not just keyword stuffing.
  const padDatasetDescription = (raw: string | null, title: string): string => {
    const base = (raw && raw.trim().length > 0 ? raw.trim() : title).trim();
    if (base.length >= 50) return base;
    const tail = ` Published by ${data.org.name} on the GratisGIS open-source geospatial portal.`;
    return (base + tail).slice(0, 5000);
  };
  const publisher = {
    '@type': 'Organization',
    name: data.org.name,
    url: portalUrl('/'),
  } as const;

  const elements = data.items.map((item, index) => {
    const isDataset = dataLayerLike.has(item.type);
    const itemAbsoluteUrl = portalUrl(`/items/${item.id}`);
    const node: Record<string, unknown> = {
      '@type': isDataset ? 'Dataset' : 'CreativeWork',
      name: item.title,
      // Absolute URL so the JSON-LD is portable across hostnames
      // (canonical preview, self-host deployments) and unambiguous
      // for Rich Results validation.
      url: itemAbsoluteUrl,
      dateModified: item.updatedAt,
    };
    // Dataset: spell out description (padded if too short), creator,
    // publisher, and license to satisfy Google's Dataset rich-result
    // spec.  CreativeWork: just attach description / image if present;
    // Google doesn't validate those nodes the same way.
    if (isDataset) {
      node.description = padDatasetDescription(item.description, item.title);
      // Creator + publisher are both required-recommended fields on
      // Dataset.  We don't track per-item authorship publicly today,
      // so the publishing org plays both roles.  When per-item owner
      // metadata becomes public-safe, swap creator to the owner.
      node.creator = publisher;
      node.publisher = publisher;
      if (item.license && item.license.trim().length > 0) {
        node.license = item.license.trim();
      }
    } else if (item.description) {
      node.description = item.description;
    }
    if (item.tags.length > 0) node.keywords = item.tags;
    if (item.thumbnailUrl) node.image = item.thumbnailUrl;
    return {
      '@type': 'ListItem',
      position: index + 1,
      item: node,
    };
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: data.org.title,
    ...(data.org.subtitle ? { description: data.org.subtitle } : {}),
    publisher,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: data.items.length,
      itemListElement: elements,
    },
  };
}
