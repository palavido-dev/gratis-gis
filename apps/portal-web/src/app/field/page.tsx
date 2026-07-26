// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ClipboardList, LogIn } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
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
  try {
    deployments = await apiFetch<ItemWithShares[]>(
      '/api/items?type=data_collection&full=1',
    );
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

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      {/* Mobile: just the title -- this is a field worker's
          launchpad, nothing else. The descriptive copy and the
          "New deployment" button are author affordances and only
          surface from sm: up. Saves vertical real estate on
          iPhone where every row of the deployment list matters
          more than the marketing line. */}
      <header className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Field
          </h1>
          <p className="mt-1 hidden text-sm text-muted sm:block">
            Deployments you can open in the field, with offline-cache and
            sync state for this device.
          </p>
        </div>
        <Link
          href="/items/new?type=data_collection"
          className="hidden h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 sm:inline-flex"
        >
          <ClipboardList className="h-4 w-4" />
          New deployment
        </Link>
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
        <EmptyState
          icon={<LogIn className="h-5 w-5" />}
          title="Your session expired"
          description="Sign in again to load your field deployments. Any features you've already saved offline are safe; they'll sync once you're back online and signed in."
          action={
            <a
              href="/api/auth/signin?callbackUrl=%2Ffield"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </a>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-5 w-5" />}
          title="No field deployments yet"
          description="A field deployment points at a map and the form workers fill out when they add features. Create one to start collecting data in the field."
          action={
            <Link
              href="/items/new?type=data_collection"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
            >
              <ClipboardList className="h-4 w-4" />
              Create a deployment
            </Link>
          }
        />
      ) : (
        <FieldCatalog rows={rows} />
      )}
    </div>
  );
}
