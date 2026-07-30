// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArrowRightLeft,
  Bell,
  ClipboardList,
  Folder as FolderIcon,
  LayoutGrid,
  Map as MapIcon,
  Menu as MenuIcon,
  Paintbrush,
  Rocket,
  Shield,
  Sparkles,
  Trash2,
  Users,
  X as CloseIcon,
} from 'lucide-react';

import { signIn, useSession } from 'next-auth/react';

import { useT } from '@/lib/i18n/locale-context';
import { isSessionStale } from '@/lib/session-state';

import { TopBarSearch } from './top-bar-search';
import { HelpButton } from './help-button';
import { UserMenu } from './user-menu';
import { BrandWordmark } from './brand-mark';

/**
 * Client wrapper that owns the conditional render of the global
 * chrome (sidebar nav + top bar). Lives separately from AppShell
 * because the path-based suppression has to happen client-side:
 * the previous attempt (read x-gratis-pathname stamped by
 * middleware) lost the header in some prod paths, leaving the
 * search-items chrome stacked on top of the field runtime's own
 * full-bleed UI on mobile.
 *
 * usePathname() always reflects the live route, before and after
 * client-side navigation, so the chrome correctly disappears the
 * instant the user opens a deployment from /field and reappears
 * when they back out.
 *
 * Suppressed routes:
 *   /items/<id>/field         field runtime owns the full screen
 *   /items/<id>/field/...     subroutes (offline shell, etc.)
 *   /items/<id>/viewer/run    web-app viewer
 *   /items/<id>/editor/run    web-app editor
 *   /items/<id>/custom/run    web-app custom runtime
 *   /items/<id>/responses     per-form response viewer (#91)
 *   /forms/<id>/respond       respondent-facing form runtime (#345)
 *
 * Everything else gets the full chrome.
 */
export interface AppShellMe {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  orgName: string | null;
  orgRole: 'viewer' | 'contributor' | 'admin';
}

export function AppShellChrome({
  me,
  signedIn,
  sessionStale,
  fallbackName,
  fallbackEmail,
  children,
}: {
  me: AppShellMe | null;
  signedIn: boolean;
  /** Session cookie present, Keycloak tokens dead (#195). */
  sessionStale: boolean;
  fallbackName: string | null;
  fallbackEmail: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const t = useT();
  // The server render decides the first paint so there is no flash of
  // a signed-in header. After that the client session takes over,
  // which means the header heals itself on the same window-focus
  // refetch that unmounts the expired-session banner: `data` is
  // undefined only while that first fetch is in flight.
  const { data: clientSession } = useSession();
  const stale =
    clientSession === undefined ? sessionStale : isSessionStale(clientSession);

  // Field-runtime path: render bare. Same predicate as the
  // server-side check used to use; kept here so a future widening
  // (e.g. a different full-screen surface) is one regex tweak.
  //
  // Viewer / editor runtimes get the same treatment (#307). They
  // already render their own WAB-style header (title, toolbar,
  // basemap selector); the portal sidebar layered on top of that
  // makes a public-share link look cluttered and breaks AGOL parity.
  // Rendering bare lets a shared link open the runtime as the
  // entire viewport, just like AGOL Web App Builder.
  const isFieldRuntime = /^\/items\/[^/]+\/field(?:\/|$)/.test(pathname);
  // Web-app runtimes that own their own header + chrome. Viewer,
  // editor, and custom each ship a configure-back link in their
  // own header, so layering the portal sidebar on top makes a
  // public-share link feel cluttered and breaks AGOL parity.
  const isAppRuntime =
    /^\/items\/[^/]+\/(?:viewer|editor|custom)\/run(?:\/|$)/.test(
      pathname,
    );
  // #91: the per-form Responses viewer also ships its own runtime
  // header (FormView side panel, attribute table, layer pills).
  // Same treatment as Viewer/Editor/Custom so a public-share link
  // to /items/<id>/responses lands on a clean canvas.
  const isResponsesViewer = /^\/items\/[^/]+\/responses(?:\/|$)/.test(
    pathname,
  );
  // Form respondent runtime (#345). The detail page already opens
  // /forms/<id>/respond in a new tab; rendering bare lets the
  // tab stand on its own as a sharable submission surface, the way
  // an AGO Survey123 link does.
  const isFormRespond = /^\/forms\/[^/]+\/respond(?:\/|$)/.test(pathname);
  // #101 print-template render page.  The page is opened in a new
  // tab from the Print widget so the user can save-as-PDF; the
  // portal sidebar + top bar sitting on top of the paper preview
  // makes the print dialog capture the wrong viewport.  Render
  // bare so the page IS the paper.
  const isPrintRender = /^\/print\/[^/]+(?:\/|$)/.test(pathname);
  if (
    isFieldRuntime ||
    isAppRuntime ||
    isResponsesViewer ||
    isFormRespond ||
    isPrintRender
  ) {
    return (
      <div className="min-h-screen bg-surface-0 text-ink-0">{children}</div>
    );
  }

  // Unauthenticated: still no chrome. The page below renders its
  // own header (e.g. PublicLanding's TopBar).
  if (!signedIn) {
    return (
      <div className="min-h-screen bg-surface-0 text-ink-0">{children}</div>
    );
  }

  return (
    <div className="flex min-h-screen bg-surface-0 text-ink-0">
      {/* Sticky left rail so the nav stays in view while a long
          items page scrolls underneath.  Otherwise drag-and-drop
          to a folder breaks once the rail scrolls off-screen.
          `sticky top-0 self-start` plus `h-screen overflow-y-auto`
          on the inner column lets the nav grow taller than the
          viewport (admin rail with many entries) without breaking
          the parent flexbox.

          Hidden below the md breakpoint; the mobile drawer below
          renders the same content as a slide-in overlay. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 self-start overflow-y-auto border-r border-border bg-surface-1 px-3 py-4 md:block">
        <Link href="/" className="flex items-center gap-2 px-2 py-2">
          <BrandWordmark markSize={26} />
        </Link>
        <NavList orgRole={me?.orgRole ?? null} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar reserves env(safe-area-inset-top) so iOS status
            bar / dynamic island doesn't sit on top of the user-menu
            button when the app is launched from a home-screen PWA
            install (viewport-fit=cover puts the page under the
            status bar by design). */}
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-surface-0/80 px-3 backdrop-blur pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
          <div className="flex flex-1 items-center gap-2">
            <MobileNavTrigger orgRole={me?.orgRole ?? null} />
            <TopBarSearch />
          </div>
          <div className="flex items-center gap-2">
            <HelpButton />
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
              aria-label={t('shell.notificationsLabel')}
            >
              <Bell className="h-4 w-4" />
            </button>
            {/* A stale session is a signed-out session as far as the
                API is concerned, so the header must not keep showing
                the person's name and avatar next to a banner telling
                them their sign-in expired. Same action as the banner,
                kept here because the header is where people look for
                who they are signed in as. */}
            {stale ? (
              <button
                type="button"
                onClick={() => void signIn('keycloak')}
                className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
              >
                {t('nav.signIn')}
              </button>
            ) : (
              <UserMenu
                seed={me?.id ?? fallbackEmail ?? 'you'}
                displayName={me?.fullName ?? fallbackName ?? 'You'}
                orgName={me?.orgName ?? null}
                avatarUrl={me?.avatarUrl ?? null}
              />
            )}
          </div>
        </header>

        <main className="flex-1 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}

/**
 * The same nav links the desktop left rail uses, factored out so the
 * mobile drawer and the desktop sidebar render identical entries.
 * Clicking a link inside the drawer fires the optional `onNavigate`
 * callback so the parent can close the drawer.
 */
function NavList({
  orgRole,
  onNavigate,
}: {
  orgRole: AppShellMe['orgRole'] | null;
  /** Same typing as NavLink.onNavigate: explicit `| undefined`
   *  so the desktop call site can omit it without tripping
   *  exactOptionalPropertyTypes. */
  onNavigate?: (() => void) | undefined;
}) {
  // Normalize to the explicit-or-undefined shape NavLink wants
  // so we don't have to repeat the conditional spread at every
  // call site below.
  const cb = onNavigate;
  const t = useT();
  return (
    <nav className="mt-4 flex flex-col gap-0.5 text-sm">
      <NavLink href="/" icon={<LayoutGrid className="h-4 w-4" />} onNavigate={cb}>
        {t('nav.overview')}
      </NavLink>
      <NavLink href="/items" icon={<MapIcon className="h-4 w-4" />} onNavigate={cb}>
        {t('nav.items')}
      </NavLink>
      <NavLink
        href="/items?folders=open"
        icon={<FolderIcon className="h-4 w-4" />}
        onNavigate={cb}
      >
        {t('nav.folders')}
      </NavLink>
      <NavLink href="/groups" icon={<Users className="h-4 w-4" />} onNavigate={cb}>
        {t('nav.groups')}
      </NavLink>
      {/* The /field landing is intentionally hidden from the
          sidebar.  The route stays valid so a mobile user who
          scans a deployment QR code or shares a direct link still
          lands on it, but other users reach field deployments
          more naturally through the items list + the "Field"
          item-type filter.  Don't reintroduce a top-level entry
          here without a redesign. */}
      <NavLink
        href="/recently-deleted"
        icon={<Trash2 className="h-4 w-4" />}
        onNavigate={cb}
      >
        {t('nav.recentlyDeleted')}
      </NavLink>
      {orgRole === 'admin' ? (
        <>
          <p className="mt-4 px-2 text-2xs font-medium uppercase tracking-wide text-muted">
            {t('nav.admin')}
          </p>
          <GettingStartedNavLink onNavigate={cb} />
          <NavLink
            href="/admin/users"
            icon={<Shield className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.users')}
          </NavLink>
          <NavLink
            href="/admin/branding"
            icon={<Paintbrush className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.landingPage')}
          </NavLink>
          <NavLink
            href="/admin/backup"
            icon={<Archive className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.backup')}
          </NavLink>
          <NavLink
            href="/admin/housekeeping"
            icon={<Sparkles className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.housekeeping')}
          </NavLink>
          <NavLink
            href="/admin/notifications"
            icon={<Bell className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.notifications')}
          </NavLink>
          <NavLink
            href="/admin/field-queues"
            icon={<ClipboardList className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.fieldQueues')}
          </NavLink>
          {/* Migrations sits at the bottom of Admin on purpose: it is
              a real first-class admin task but a one-shot tool, not
              part of daily ops. Bidirectional name leaves room for
              "to AGO" / "to PostGIS" / etc. siblings on the same
              landing page. */}
          <NavLink
            href="/admin/migrations"
            icon={<ArrowRightLeft className="h-4 w-4" />}
            onNavigate={cb}
          >
            {t('nav.migrations')}
          </NavLink>
        </>
      ) : null}
    </nav>
  );
}

/**
 * "Getting started" admin nav entry (#147 Phase 3). Only renders
 * while the org still has open checklist items, with a count pill;
 * once everything is done or dismissed the entry disappears (the
 * page itself stays reachable by URL). Fetches its own status
 * client-side after mount rather than widening the /users/me
 * payload: the count costs a few queries that only admins should
 * ever pay, and only once per full page load since the chrome
 * survives client-side navigation. The getting-started page
 * broadcasts `gg:onboarding-changed` after each mutation so the
 * pill updates without a reload.
 */
function GettingStartedNavLink({
  onNavigate,
}: {
  onNavigate: (() => void) | undefined;
}) {
  const t = useT();
  const [openCount, setOpenCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/portal/admin/onboarding');
        if (!res.ok) return;
        const body = (await res.json()) as { openCount: number };
        if (!cancelled) setOpenCount(body.openCount);
      } catch {
        /* leave hidden; the nav must never break on a fetch error */
      }
    }
    void load();
    window.addEventListener('gg:onboarding-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('gg:onboarding-changed', load);
    };
  }, []);

  if (openCount === null || openCount === 0) return null;

  return (
    <Link
      href="/admin/getting-started"
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-ink-1 transition-colors hover:bg-surface-2"
    >
      <span className="text-muted">
        <Rocket className="h-4 w-4" />
      </span>
      {t('nav.gettingStarted')}
      <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent/15 px-1.5 text-2xs font-medium text-accent">
        {openCount}
      </span>
    </Link>
  );
}

/**
 * Mobile-only hamburger + slide-in drawer.  Visible below the md
 * breakpoint (where the desktop left rail is hidden).  The drawer
 * is a fixed-position overlay so it can render above the sticky
 * header without fighting it for stacking context.
 *
 * Interactions:
 *   - Click hamburger to open.
 *   - Click backdrop, Esc key, or any link inside the drawer to
 *     close.
 *   - Page navigation also closes the drawer via usePathname change
 *     (handled by an effect below).
 */
function MobileNavTrigger({
  orgRole,
}: {
  orgRole: AppShellMe['orgRole'] | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Track when the component has mounted so the portal target
  // (document.body) is available.  Without this guard the SSR
  // pass calls createPortal with no document and crashes.
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on route change.  Navigating from inside the drawer fires
  // onNavigate to set open=false, but a route change initiated
  // elsewhere (back button, deep link) should also dismiss.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Esc.  Standard accessibility convention for overlays.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Prevent body scroll while the drawer is open so the underlying
  // page doesn't jitter when the user swipes inside the drawer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // The drawer itself is rendered through a portal to document.body
  // so it escapes any ancestor that would otherwise act as a
  // containing block for its `position: fixed` panel.  The sticky
  // top bar uses `backdrop-blur`, and per the CSS spec any element
  // with a non-`none` `backdrop-filter` becomes the containing
  // block for fixed descendants.  Without the portal the drawer
  // ends up sized to the 56px header instead of the full viewport,
  // which presents as "the drawer only shows one nav item at a
  // time, the rest scrolls".
  const drawer =
    open && mounted
      ? createPortal(
          <div
            className="fixed inset-0 z-50 md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.navigation')}
          >
            {/* Backdrop. Click to dismiss. */}
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            {/* Drawer panel.  Slide-in from the left. */}
            <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface-1 px-3 py-4 shadow-xl">
              <div className="flex items-center justify-between px-2 py-2">
                <Link
                  href="/"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2"
                >
                  <BrandWordmark markSize={26} />
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t('shell.closeNavigation')}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>
              <NavList orgRole={orgRole} onNavigate={() => setOpen(false)} />
            </aside>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('shell.openNavigation')}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2 md:hidden"
      >
        <MenuIcon className="h-5 w-5" />
      </button>
      {drawer}
    </>
  );
}

function NavLink({
  href,
  icon,
  children,
  onNavigate,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  /** Called on click before navigation; used by the mobile drawer
   *  to close itself when the user taps a link.  Typed with explicit
   *  `| undefined` because the consuming Link rejects an undefined
   *  onClick prop under exactOptionalPropertyTypes. */
  onNavigate: (() => void) | undefined;
}) {
  return (
    <Link
      href={href}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-ink-1 transition-colors hover:bg-surface-2"
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Link>
  );
}
