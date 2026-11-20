// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { CircleUserRound, ClipboardList, LogIn } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { getServerLocale } from '@/lib/i18n/server';
import { t } from '@/lib/i18n';
import { FieldCatalog, type FieldDeploymentRow } from './field-catalog';

/**
 * Field catalog landing page (Slice 7 of the Field Maps arc; see
 * docs/field-offline-areas.md). The dedicated lens for field
 * deployments. Lists every `data_collection` item the user has
 * access to, with per-row offline-cache state and queued-edit
 * count layered in client-side.
 *
 * This sits alongside the generic items list rather than replacing
 * it. The items list is the everything view; this is the field
 * worker's "what am I working on today" view, mirroring how Field
 * Maps gives map workers a curated map list separate from the
 * generic content browser.
 *
 * The cache and queue surfaces are read from IndexedDB so they
 * have to land on the client. The server component fetches the
 * deployment metadata (title, owner, mapId, share count) since
 * those are auth-gated; the client mounts and walks
 * `listDeployments()` and `listQueue()` for the device-local view.
 */
export default async function FieldCatalogPage() {
  // Pull every data_collection item the user has access to. The
  // multi-type filter on /api/portal/items (#51) makes this a
  // single round-trip; we forward the rows verbatim and let the
  // client component merge the IDB-side state.
  let deployments: ItemWithShares[] = [];
  let sessionExpired = false;
  let loadFailed = false;
  // The catalog reads the offline queue as the signed-in account (its
  // counts and its per-row Sync drain only this account's rows), so it
  // needs the same portal user id the field runtime receives. Fetched
  // in parallel with the list; a 401 on either means the session is
  // dead and lands in the same branch below.
  let currentUserId = '';
  try {
    const [list, me] = await Promise.all([
      apiFetch<ItemWithShares[]>('/api/items?type=data_collection&full=1'),
      apiFetch<{ id: string }>('/api/users/me'),
    ]);
    deployments = list;
    currentUserId = me.id;
  } catch (err) {
    // #254 phase 2: distinguish auth failure (silent session expiry,
    // common after the PWA has been backgrounded for a while) from
    // anything else. A 401 is the case the field user runs into
    // most: the cookie is still present (so middleware lets them
    // through to this server component) but the JWT is expired (so
    // portal-api rejects). Without this branch, the page rendered
    // the empty "no deployments yet" state, leaving the user
    // confused about why their existing deployments disappeared.
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      sessionExpired = true;
    } else {
      loadFailed = true;
    }
    // Non-401 failures fall through to the same empty state as
    // before; the homepage CTA gives them a path out.
    deployments = [];
  }

  const rows: FieldDeploymentRow[] = deployments.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    ownerLabel: typeof item.owner === 'string' ? item.owner : null,
    updatedAt: item.updatedAt,
    thumbnailUrl: item.thumbnailUrl ?? null,
    // The data_collection's bound map id, when present. Resolved
    // client-side to "Map: <map title>" (the client already pulls
    // the deployment manifest for cache state, so adding a map
    // title would mean either a per-row API call here or a join
    // we don't have today; we punt to the runtime page).
    mapId:
      (item.data as { mapId?: string } | null)?.mapId &&
      typeof (item.data as { mapId?: string }).mapId === 'string'
        ? (item.data as { mapId: string }).mapId
        : null,
  }));

  const locale = await getServerLocale();
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
      {/* The installed field app's home screen (#768): no portal
          chrome, a large title, and one way back to the portal at
          the top left, the way native field apps open on a list of
          maps. The "New deployment" button is an author affordance
          and only shows from sm: up. */}
      <div className="flex h-11 items-center justify-between">
        <Link
          href="/"
          aria-label={t('field.openPortal', undefined, locale)}
          title={t('field.openPortal', undefined, locale)}
          className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-accent hover:bg-surface-2"
        >
          <CircleUserRound className="h-8 w-8" strokeWidth={1.75} />
        </Link>
        <Link
          href="/items/new?type=data_collection"
          className="hidden h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 sm:inline-flex"
        >
          <ClipboardList className="h-4 w-4" />
          {t('field.newDeployment', undefined, locale)}
        </Link>
      </div>
      <header className="mb-4 mt-1">
        <h1 className="text-3xl font-bold tracking-tight text-ink-0">
          {t('field.nav', undefined, locale)}
        </h1>
        <p className="mt-1 hidden text-sm text-muted sm:block">
          {t('field.intro', undefined, locale)}
        </p>
      </header>

      {sessionExpired ? (
        // #254 phase 2: session-expiry-specific empty state. The
        // sign-in link carries callbackUrl=/field so a successful
        // re-auth lands the user back on this catalog (not /items),
        // matching the field-only sandbox semantics from phase 1.
        // Using a plain <a> instead of <Link> so the browser does
        // a full navigation -- NextAuth's signin route relies on
        // server-side redirect handling that can be foiled by
        // client-side router prefetching.
        <div role="alert">
          <EmptyState
            icon={<LogIn className="h-5 w-5" />}
            title={t('field.sessionExpiredTitle', undefined, locale)}
            description={t('field.sessionExpiredBody', undefined, locale)}
            action={
              <a
                href="/signin?callbackUrl=%2Ffield"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 focus:outline-hidden focus:ring-2 focus:ring-accent/30"
              >
                <LogIn className="h-4 w-4" />
                {t('nav.signIn', undefined, locale)}
              </a>
            }
          />
        </div>
      ) : loadFailed ? (
        <div role="alert">
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" />}
            title={t('field.loadFailedTitle', undefined, locale)}
            description={t('field.loadFailedBody', undefined, locale)}
          />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-5 w-5" />}
          title={t('field.emptyTitle', undefined, locale)}
          description={t('field.emptyBody', undefined, locale)}
          action={
            <Link
              href="/items/new?type=data_collection"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 focus:outline-hidden focus:ring-2 focus:ring-accent/30"
            >
              <ClipboardList className="h-4 w-4" />
              {t('field.createDeployment', undefined, locale)}
            </Link>
          }
        />
      ) : (
        <FieldCatalog
          rows={rows}
          currentUserId={currentUserId}
          sectionLabel={t('field.sectionDeployments', undefined, locale)}
        />
      )}
    </div>
  );
}
