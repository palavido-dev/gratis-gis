'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  Timer,
  Trash2,
  User as UserIcon,
  UserX,
  Users,
  X,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import { getItemTypeAccent, getItemTypeIcon } from '@/lib/item-type-icon';
import { ReassignOwnerDialog } from '@/components/reassign-owner-dialog';

/**
 * Wire shapes returned by /admin/housekeeping endpoints. Kept
 * local to this file so the server page and the client view stay
 * in lock-step without a third file to sync.
 */
export interface HousekeepingBundle {
  summary: {
    staleItemDays: number;
    staleUserDays: number;
    staleItemCount: number;
    staleUserCount: number;
    totalItemCount: number;
    totalUserCount: number;
    /** "Soon to expire" lookahead window (#86), in days. */
    expiryWindowDays: number;
    expiringShareCount: number;
    expiringUserCount: number;
  };
  staleItems: Array<{
    id: string;
    title: string;
    type: ItemType;
    access: string;
    updatedAt: string;
    ownerId: string;
    ownerLabel: string;
  }>;
  staleUsers: Array<{
    id: string;
    username: string;
    fullName: string;
    email: string;
    orgRole: string;
    createdAt: string;
    lastSeenAt: string | null;
    ownedItemCount: number;
  }>;
  largeItems: Array<{
    id: string;
    title: string;
    type: string;
    ownerId: string;
    ownerLabel: string;
    sizeBytes: number;
    updatedAt: string;
  }>;
  expiringShares: Array<{
    itemId: string;
    itemTitle: string;
    itemType: ItemType;
    principalType: 'user' | 'group';
    principalId: string;
    principalLabel: string;
    permission: string;
    expiresAt: string;
    isExpired: boolean;
  }>;
  expiringUsers: Array<{
    id: string;
    username: string;
    fullName: string;
    email: string;
    orgRole: string;
    autoDisableAt: string;
    lastSeenAt: string | null;
    ownedItemCount: number;
    isExpired: boolean;
  }>;
}

interface Props {
  bundle: HousekeepingBundle;
}

export function HousekeepingView({ bundle }: Props) {
  const router = useRouter();
  const {
    summary,
    staleItems,
    staleUsers,
    largeItems,
    expiringShares,
    expiringUsers,
  } = bundle;

  // One selection set per table: items and users live in different
  // domains so mixing them would make the bulk-action copy
  // ambiguous. Each set is the id of a ticked row.
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'items' | 'users' | 'extents' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * Recompute every spatial item's cached bbox (#90). Walks all
   * data_layers / maps / boundaries / *_services and rewrites
   * item.bbox from the most accurate source available (PostGIS
   * feature extent for v3 data_layers, aggregated references for
   * maps, etc). Surfaces the per-type updated count so the admin
   * can see which categories actually moved.
   */
  async function recomputeExtents() {
    setBusy('extents');
    setError(null);
    try {
      const r = await fetch('/api/portal/admin/housekeeping/recompute-extents', {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const result = (await r.json()) as {
        scanned: number;
        updated: number;
        perType: Record<string, number>;
      };
      const breakdown = Object.entries(result.perType)
        .map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`)
        .join(', ');
      setFlash(
        `Recomputed extents for ${result.updated} of ${result.scanned} items${
          breakdown ? ` (${breakdown})` : ''
        }.`,
      );
      setTimeout(() => setFlash(null), 5000);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not recompute extents.',
      );
    } finally {
      setBusy(null);
    }
  }

  // Users who own items can still be ticked: clicking "Disable
  // sign-in" pops the reassign dialog so the admin picks a new owner
  // (defaulting to themselves), we reassign in bulk, and then disable
  // all selected accounts. Matches the existing "delete user with
  // owned items" flow on /admin/users.
  const [me, setMe] = useState<{ id: string; fullName: string; username: string } | null>(
    null,
  );
  useEffect(() => {
    void fetch('/api/portal/users/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setMe(u))
      .catch(() => {});
  }, []);

  // When a bulk-disable involves users with owned items, stash the
  // batch here so the reassign dialog can drive the full workflow.
  const [pendingDisable, setPendingDisable] = useState<{
    userIds: string[];
    itemIds: string[];
    ownersWithItems: Array<{ id: string; label: string; itemCount: number }>;
  } | null>(null);

  async function bulkTrashItems() {
    if (selectedItems.size === 0) return;
    setBusy('items');
    setError(null);
    try {
      // One DELETE per item. The /items/:id endpoint soft-deletes
      // into the recycle bin; there's no bulk endpoint today, and
      // this runs on at most ~20 rows per page so the N-round-trips
      // cost is fine. Concurrency set to 4 to keep the UI responsive
      // without hammering the API.
      const ids = Array.from(selectedItems);
      await runBatched(ids, 4, async (id) => {
        const res = await fetch(`/api/portal/items/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`Item ${id.slice(0, 8)}: HTTP ${res.status}`);
      });
      setSelectedItems(new Set());
      setFlash(`Moved ${ids.length} item${ids.length === 1 ? '' : 's'} to the recycle bin.`);
      setTimeout(() => setFlash(null), 4000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move items to trash.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Apply `{ enabled: false }` to every id in the list. Used by
   * both the "no owned items" and the "already reassigned" paths.
   */
  async function disableUsers(ids: string[]) {
    await runBatched(ids, 4, async (id) => {
      const res = await fetch(`/api/portal/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      if (!res.ok) throw new Error(`User ${id.slice(0, 8)}: HTTP ${res.status}`);
    });
  }

  async function bulkDisableUsers() {
    if (selectedUsers.size === 0) return;
    setBusy('users');
    setError(null);
    try {
      const ids = Array.from(selectedUsers);
      const selectedRows = staleUsers.filter((u) => selectedUsers.has(u.id));
      const withItems = selectedRows.filter((u) => u.ownedItemCount > 0);

      // Fast path: nobody in the batch owns anything, just disable.
      if (withItems.length === 0) {
        await disableUsers(ids);
        setSelectedUsers(new Set());
        setFlash(
          `Disabled sign-in for ${ids.length} user${ids.length === 1 ? '' : 's'}.`,
        );
        setTimeout(() => setFlash(null), 4000);
        router.refresh();
        return;
      }

      // Slow path: collect the item ids those users own, then open
      // the reassign dialog. We fetch per-user via the items list
      // endpoint filtered by ownerId; the API already supports that
      // query shape so no new endpoint is needed.
      const perUserItems = await Promise.all(
        withItems.map(async (u) => {
          const r = await fetch(
            `/api/portal/items?ownerId=${encodeURIComponent(u.id)}`,
          );
          if (!r.ok) throw new Error(`Could not list ${u.username}'s items`);
          const rows = (await r.json()) as Array<{ id: string }>;
          return rows.map((r) => r.id);
        }),
      );
      const itemIds = perUserItems.flat();
      setPendingDisable({
        userIds: ids,
        itemIds,
        ownersWithItems: withItems.map((u) => ({
          id: u.id,
          label: u.fullName?.trim() || u.username,
          itemCount: u.ownedItemCount,
        })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare disable.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Dialog submit: bulk-reassign the stashed item ids to the picked
   * new owner, then disable every ticked user. No "keep previous
   * access" option because the previous owners are about to lose
   * their sign-in anyway.
   */
  async function confirmReassignAndDisable(newOwnerId: string) {
    if (!pendingDisable) return;
    setBusy('users');
    setError(null);
    try {
      if (pendingDisable.itemIds.length > 0) {
        const r = await fetch('/api/portal/items/bulk/reassign-owner', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            itemIds: pendingDisable.itemIds,
            newOwnerId,
            keepPreviousOwnerAccess: null,
          }),
        });
        if (!r.ok) throw new Error(`Reassign failed: HTTP ${r.status}`);
      }
      await disableUsers(pendingDisable.userIds);
      const userCount = pendingDisable.userIds.length;
      const itemCount = pendingDisable.itemIds.length;
      setPendingDisable(null);
      setSelectedUsers(new Set());
      setFlash(
        `Reassigned ${itemCount} item${itemCount === 1 ? '' : 's'} and disabled ${userCount} user${userCount === 1 ? '' : 's'}.`,
      );
      setTimeout(() => setFlash(null), 4500);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete the reassign + disable.');
    } finally {
      setBusy(null);
    }
  }

  // ----- Expiring-share / expiring-user actions (#86) -----
  // Each row ends with quick actions: extend (+30 days), cancel,
  // or disable now. We hit the existing per-resource endpoints
  // (POST /items/:id/share, DELETE /items/:id/share, PATCH
  // /admin/users/:id) so the audit log treats these as if the
  // admin had used the per-item / per-user surfaces directly.
  async function extendShare(
    row: HousekeepingBundle['expiringShares'][number],
    days: number,
  ) {
    setError(null);
    const next = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`/api/portal/items/${row.itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: row.principalType,
        principalId: row.principalId,
        permission: row.permission,
        expiresAt: next,
      }),
    });
    if (!res.ok) {
      setError(`Could not extend share: HTTP ${res.status}`);
      return;
    }
    setFlash(`Extended share on "${row.itemTitle}" by ${days} days.`);
    setTimeout(() => setFlash(null), 4000);
    router.refresh();
  }
  async function cancelShare(row: HousekeepingBundle['expiringShares'][number]) {
    setError(null);
    const res = await fetch(`/api/portal/items/${row.itemId}/share`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: row.principalType,
        principalId: row.principalId,
      }),
    });
    if (!res.ok) {
      setError(`Could not cancel share: HTTP ${res.status}`);
      return;
    }
    setFlash(`Cancelled share on "${row.itemTitle}".`);
    setTimeout(() => setFlash(null), 4000);
    router.refresh();
  }
  async function extendUser(
    row: HousekeepingBundle['expiringUsers'][number],
    days: number,
  ) {
    setError(null);
    const next = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`/api/portal/admin/users/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoDisableAt: next }),
    });
    if (!res.ok) {
      setError(`Could not extend ${row.username}: HTTP ${res.status}`);
      return;
    }
    setFlash(`Extended ${row.username} by ${days} days.`);
    setTimeout(() => setFlash(null), 4000);
    router.refresh();
  }
  async function clearUserExpiry(row: HousekeepingBundle['expiringUsers'][number]) {
    setError(null);
    const res = await fetch(`/api/portal/admin/users/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoDisableAt: null }),
    });
    if (!res.ok) {
      setError(`Could not cancel auto-disable: HTTP ${res.status}`);
      return;
    }
    setFlash(`Removed auto-disable from ${row.username}.`);
    setTimeout(() => setFlash(null), 4000);
    router.refresh();
  }
  async function disableUserNow(row: HousekeepingBundle['expiringUsers'][number]) {
    setError(null);
    const res = await fetch(`/api/portal/admin/users/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    if (!res.ok) {
      setError(`Could not disable ${row.username}: HTTP ${res.status}`);
      return;
    }
    setFlash(`Disabled ${row.username} immediately.`);
    setTimeout(() => setFlash(null), 4000);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SummaryBar summary={summary} />

      {/* Maintenance bar (#90): one-click recompute of every spatial
          item's cached bbox. Useful after a bulk import / fixture
          load when item.bbox wasn't populated; usually a no-op
          afterwards. Lives at the top of the page so admins can
          run it before sorting through the lists below. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
        <span className="text-muted">
          Recompute spatial extents (item.bbox) for every map / data
          layer / boundary / external service in your org. Run after
          bulk imports if the area filter looks off.
        </span>
        <button
          type="button"
          onClick={recomputeExtents}
          disabled={busy === 'extents'}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === 'extents' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Database className="h-3.5 w-3.5" />
          )}
          Recompute extents
        </button>
      </div>

      {flash ? (
        <div className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          {flash}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {error}
        </div>
      ) : null}

      {/* Soon-to-expire shares (#86). Mixes already-expired
          (red) and within-window (amber) rows so the admin can
          deal with both in one place. Empty list collapses to a
          friendly note rather than vanishing entirely so the panel
          location is predictable. */}
      <Section
        icon={<CalendarClock className="h-4 w-4" />}
        title={`Shares expiring in the next ${summary.expiryWindowDays} days`}
        empty="No shares are scheduled to expire in this window."
        caption={
          expiringShares.length === 0
            ? null
            : 'Already-expired rows show in red; upcoming ones in amber. Use the row actions to extend, cancel, or open the item.'
        }
      >
        {expiringShares.length === 0 ? null : (
          <ExpiringSharesTable
            rows={expiringShares}
            onExtend={extendShare}
            onCancel={cancelShare}
          />
        )}
      </Section>

      {/* Soon-to-expire user accounts (#86). Mirror of the share
          panel; each row's quick actions correspond to the three
          things an admin typically wants in this moment: keep
          them around longer, drop the timer entirely, or end it
          right now. */}
      <Section
        icon={<Timer className="h-4 w-4" />}
        title={`Users auto-disabling in the next ${summary.expiryWindowDays} days`}
        empty="No users have an auto-disable date in this window."
        caption={
          expiringUsers.length === 0
            ? null
            : 'These accounts will lose sign-in on their listed date. Extend, cancel the timer, or disable immediately.'
        }
      >
        {expiringUsers.length === 0 ? null : (
          <ExpiringUsersTable
            rows={expiringUsers}
            onExtend={extendUser}
            onClear={clearUserExpiry}
            onDisableNow={disableUserNow}
          />
        )}
      </Section>

      <Section
        icon={<Clock className="h-4 w-4" />}
        title={`Items nobody's touched for ${summary.staleItemDays}+ days`}
        empty="No stale items: every item in your org has been updated recently or is still being shared."
        caption={
          <>
            {staleItems.length === 0
              ? null
              : `Showing the ${staleItems.length} oldest untouched items with zero shares. `}
            Tick the ones you want to retire and use "Move to trash"
            below. Items go to the recycle bin first (30 day
            retention), so a mistake is easy to undo.
          </>
        }
        bulkBar={
          selectedItems.size > 0 ? (
            <BulkBar
              count={selectedItems.size}
              label="item"
              busy={busy === 'items'}
              onClear={() => setSelectedItems(new Set())}
              actions={[
                {
                  label: 'Move to trash',
                  icon: <Trash2 className="h-3.5 w-3.5" />,
                  tone: 'danger',
                  onClick: bulkTrashItems,
                },
              ]}
            />
          ) : null
        }
      >
        {staleItems.length === 0 ? null : (
          <StaleItemsTable
            rows={staleItems}
            selected={selectedItems}
            onToggle={(id) => {
              setSelectedItems((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onToggleAll={() => {
              setSelectedItems((s) => {
                const all = staleItems.every((r) => s.has(r.id));
                return all ? new Set() : new Set(staleItems.map((r) => r.id));
              });
            }}
          />
        )}
      </Section>

      <Section
        icon={<Users className="h-4 w-4" />}
        title={`Users quiet for ${summary.staleUserDays}+ days`}
        empty="Nobody looks idle. Admins are deliberately excluded from this check so a break-glass account never shows up."
        caption="Admins are excluded. Ticking a user who still owns items is fine: when you click Disable, we'll ask who to reassign their items to (defaults to you) before disabling the account."
        bulkBar={
          selectedUsers.size > 0 ? (
            <BulkBar
              count={selectedUsers.size}
              label="user"
              busy={busy === 'users'}
              onClear={() => setSelectedUsers(new Set())}
              actions={[
                {
                  label: 'Disable sign-in',
                  icon: <UserX className="h-3.5 w-3.5" />,
                  tone: 'warn',
                  onClick: bulkDisableUsers,
                },
              ]}
            />
          ) : null
        }
      >
        {staleUsers.length === 0 ? null : (
          <StaleUsersTable
            rows={staleUsers}
            selected={selectedUsers}
            onToggle={(id) => {
              setSelectedUsers((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onToggleAll={() => {
              setSelectedUsers((s) => {
                const all = staleUsers.every((u) => s.has(u.id));
                return all ? new Set() : new Set(staleUsers.map((u) => u.id));
              });
            }}
          />
        )}
      </Section>

      {pendingDisable ? (
        <ReassignOwnerDialog
          heading={`Reassign items before disabling ${pendingDisable.userIds.length} user${pendingDisable.userIds.length === 1 ? '' : 's'}`}
          subheading={(() => {
            const lines = pendingDisable.ownersWithItems
              .map((o) => `${o.label}: ${o.itemCount}`)
              .join(' · ');
            return `Items to reassign: ${lines}. Everything transfers to the new owner; the original users lose sign-in.`;
          })()}
          excludeUserIds={pendingDisable.userIds}
          saving={busy === 'users'}
          defaultOwner={
            me ? { id: me.id, label: me.fullName?.trim() || me.username } : null
          }
          onClose={() => {
            if (busy !== 'users') setPendingDisable(null);
          }}
          onSubmit={(newOwnerId) => confirmReassignAndDisable(newOwnerId)}
        />
      ) : null}

      <Section
        icon={<Database className="h-4 w-4" />}
        title="Largest items by stored size"
        empty="No items yet."
        caption="Rough size of the item's settings and metadata. Heavier items are the ones most likely to be slow to load or copy around. Actual map tiles, feature rows, and uploaded files live in separate storage and aren't counted here."
      >
        {largeItems.length === 0 ? null : (
          <LargeItemsTable rows={largeItems} />
        )}
      </Section>
    </div>
  );
}

/**
 * Run a function over a list of ids with a concurrency cap. We
 * await each batch before starting the next so a slow server
 * doesn't stack N requests in flight. No retry on failure: first
 * error throws and the caller decides what to do.
 */
async function runBatched<T>(
  ids: T[],
  concurrency: number,
  fn: (id: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    await Promise.all(batch.map((id) => fn(id)));
  }
}

/** Sticky bulk-action bar shown above the table when 1+ rows are ticked. */
function BulkBar({
  count,
  label,
  busy,
  actions,
  onClear,
}: {
  count: number;
  label: string;
  busy: boolean;
  actions: Array<{
    label: string;
    icon: React.ReactNode;
    tone: 'danger' | 'warn';
    onClick: () => void;
  }>;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/20 bg-accent/5 px-4 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">
          {count}
        </span>
        <span className="font-medium text-accent">
          {label}
          {count === 1 ? '' : 's'} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="inline-flex items-center gap-1 text-muted hover:text-ink-1 disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.onClick}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
              a.tone === 'danger'
                ? 'border-danger bg-danger/10 text-danger hover:bg-danger/20'
                : 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------

function SummaryBar({
  summary,
}: {
  summary: HousekeepingBundle['summary'];
}) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard
        icon={<Archive className="h-4 w-4 text-muted" />}
        label="Total items"
        value={summary.totalItemCount.toLocaleString()}
      />
      <StatCard
        icon={<Clock className="h-4 w-4 text-amber-700" />}
        label={`Stale (${summary.staleItemDays}d+ no edit, zero shares)`}
        value={summary.staleItemCount.toLocaleString()}
        tone={summary.staleItemCount > 0 ? 'warn' : 'ok'}
      />
      <StatCard
        icon={<UserIcon className="h-4 w-4 text-muted" />}
        label={`Quiet users (${summary.staleUserDays}d+ no sign-in)`}
        value={summary.staleUserCount.toLocaleString()}
        tone={summary.staleUserCount > 0 ? 'warn' : 'ok'}
      />
      <StatCard
        icon={<CalendarClock className="h-4 w-4 text-amber-700" />}
        label={`Shares expiring (next ${summary.expiryWindowDays}d)`}
        value={summary.expiringShareCount.toLocaleString()}
        tone={summary.expiringShareCount > 0 ? 'warn' : 'ok'}
      />
      <StatCard
        icon={<Timer className="h-4 w-4 text-amber-700" />}
        label={`Users auto-disabling (next ${summary.expiryWindowDays}d)`}
        value={summary.expiringUserCount.toLocaleString()}
        tone={summary.expiringUserCount > 0 ? 'warn' : 'ok'}
      />
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone = 'ok',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        tone === 'warn'
          ? 'border-amber-300 bg-amber-50'
          : 'border-border bg-surface-1'
      }`}
    >
      <p className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        {icon}
        {label}
      </p>
      <p className="text-2xl font-semibold text-ink-0">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------

function Section({
  icon,
  title,
  empty,
  caption,
  bulkBar,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  caption?: React.ReactNode;
  bulkBar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-1">
      <header className="border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium text-ink-0">
          {icon}
          {title}
        </h2>
        {caption ? (
          <p className="mt-0.5 text-xs text-muted">{caption}</p>
        ) : null}
      </header>
      {bulkBar}
      {children ? (
        <div>{children}</div>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------
// Tables
// ---------------------------------------------------------------

function StaleItemsTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: HousekeepingBundle['staleItems'];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="w-8 px-4 py-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              className="h-3.5 w-3.5 cursor-pointer"
              aria-label="Select all stale items"
            />
          </th>
          <th className="px-4 py-2">Title</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Owner</th>
          <th className="px-4 py-2">Last updated</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const Icon = getItemTypeIcon(r.type);
          const accent = getItemTypeAccent(r.type);
          const isSelected = selected.has(r.id);
          return (
            <tr key={r.id} className={isSelected ? 'bg-accent/5' : ''}>
              <td className="w-8 px-4 py-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(r.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                  aria-label={`Select ${r.title}`}
                />
              </td>
              <td className="px-4 py-2">
                <Link
                  href={`/items/${r.id}`}
                  className="inline-flex items-center gap-2 text-ink-0 hover:text-accent"
                >
                  <Icon className={`h-4 w-4 ${accent}`} />
                  {r.title}
                </Link>
              </td>
              <td className="px-4 py-2 text-muted">{r.type}</td>
              <td className="px-4 py-2 text-muted">{r.ownerLabel}</td>
              <td className="px-4 py-2 text-muted">
                {new Date(r.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-right">
                <Link
                  href={`/items/${r.id}`}
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  Review
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StaleUsersTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: HousekeepingBundle['staleUsers'];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.id));
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="w-8 px-4 py-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              className="h-3.5 w-3.5 cursor-pointer"
              aria-label="Select all users"
            />
          </th>
          <th className="px-4 py-2">User</th>
          <th className="px-4 py-2">Role</th>
          <th className="px-4 py-2">Last seen</th>
          <th className="px-4 py-2">Joined</th>
          <th className="px-4 py-2">Owns items</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const isSelected = selected.has(r.id);
          return (
            <tr key={r.id} className={isSelected ? 'bg-accent/5' : ''}>
              <td className="w-8 px-4 py-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(r.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                  title={`Select ${r.fullName?.trim() || r.username}`}
                />
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-col">
                  <span className="text-ink-0">
                    {r.fullName?.trim() || r.username}
                  </span>
                  <span className="text-[11px] text-muted">{r.email}</span>
                </div>
              </td>
              <td className="px-4 py-2 text-muted">{r.orgRole}</td>
              <td className="px-4 py-2 text-muted">
                {r.lastSeenAt
                  ? new Date(r.lastSeenAt).toLocaleDateString()
                  : 'Never signed in'}
              </td>
              <td className="px-4 py-2 text-muted">
                {new Date(r.createdAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-muted">
                {r.ownedItemCount > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                    {r.ownedItemCount} to reassign
                  </span>
                ) : (
                  '0'
                )}
              </td>
              <td className="px-4 py-2 text-right">
                <Link
                  href="/admin/users"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  Open
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LargeItemsTable({
  rows,
}: {
  rows: HousekeepingBundle['largeItems'];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2">Title</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Owner</th>
          <th className="px-4 py-2">Size</th>
          <th className="px-4 py-2">Last updated</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-2">
              <Link
                href={`/items/${r.id}`}
                className="text-ink-0 hover:text-accent"
              >
                {r.title}
              </Link>
            </td>
            <td className="px-4 py-2 text-muted">{r.type}</td>
            <td className="px-4 py-2 text-muted">{r.ownerLabel}</td>
            <td className="px-4 py-2 font-mono text-ink-0">
              {formatBytes(r.sizeBytes)}
            </td>
            <td className="px-4 py-2 text-muted">
              {new Date(r.updatedAt).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              <Link
                href={`/items/${r.id}`}
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Open
                <ChevronRight className="h-3 w-3" />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------
// Expiring-share / expiring-user tables (#86)
// ---------------------------------------------------------------

function ExpiringSharesTable({
  rows,
  onExtend,
  onCancel,
}: {
  rows: HousekeepingBundle['expiringShares'];
  onExtend: (
    row: HousekeepingBundle['expiringShares'][number],
    days: number,
  ) => void;
  onCancel: (row: HousekeepingBundle['expiringShares'][number]) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2">Item</th>
          <th className="px-4 py-2">Recipient</th>
          <th className="px-4 py-2">Permission</th>
          <th className="px-4 py-2">Expires</th>
          <th className="px-4 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={`${r.itemId}:${r.principalType}:${r.principalId}`}>
            <td className="px-4 py-2">
              <Link
                href={`/items/${r.itemId}`}
                className="text-ink-0 hover:text-accent"
              >
                {r.itemTitle}
              </Link>
              <span className="ml-1 text-[11px] text-muted">({r.itemType})</span>
            </td>
            <td className="px-4 py-2 text-muted">
              <span className="mr-1 inline-block rounded bg-surface-2 px-1 text-[10px] font-medium uppercase">
                {r.principalType}
              </span>
              {r.principalLabel}
            </td>
            <td className="px-4 py-2 text-muted">{r.permission}</td>
            <td className="px-4 py-2">
              <span
                className={
                  r.isExpired
                    ? 'inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger'
                    : 'inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900'
                }
                title={new Date(r.expiresAt).toLocaleString()}
              >
                {r.isExpired ? 'Expired' : 'In'} {formatRelativeShort(r.expiresAt)}
              </span>
            </td>
            <td className="px-4 py-2 text-right">
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onExtend(r, 30)}
                  className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] hover:bg-surface-2"
                  title="Extend by 30 days"
                >
                  +30d
                </button>
                <button
                  type="button"
                  onClick={() => onCancel(r)}
                  className="rounded border border-danger/40 bg-danger/5 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
                >
                  Cancel
                </button>
                <Link
                  href={`/items/${r.itemId}`}
                  className="ml-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  Open
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExpiringUsersTable({
  rows,
  onExtend,
  onClear,
  onDisableNow,
}: {
  rows: HousekeepingBundle['expiringUsers'];
  onExtend: (
    row: HousekeepingBundle['expiringUsers'][number],
    days: number,
  ) => void;
  onClear: (row: HousekeepingBundle['expiringUsers'][number]) => void;
  onDisableNow: (row: HousekeepingBundle['expiringUsers'][number]) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2">User</th>
          <th className="px-4 py-2">Role</th>
          <th className="px-4 py-2">Auto-disables</th>
          <th className="px-4 py-2">Owns items</th>
          <th className="px-4 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-2">
              <div className="flex flex-col">
                <span className="text-ink-0">
                  {r.fullName?.trim() || r.username}
                </span>
                <span className="text-[11px] text-muted">{r.email}</span>
              </div>
            </td>
            <td className="px-4 py-2 text-muted">{r.orgRole}</td>
            <td className="px-4 py-2">
              <span
                className={
                  r.isExpired
                    ? 'inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger'
                    : 'inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900'
                }
                title={new Date(r.autoDisableAt).toLocaleString()}
              >
                {r.isExpired ? 'Past due' : 'In'}{' '}
                {formatRelativeShort(r.autoDisableAt)}
              </span>
            </td>
            <td className="px-4 py-2 text-muted">
              {r.ownedItemCount > 0 ? (
                <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                  {r.ownedItemCount}
                </span>
              ) : (
                '0'
              )}
            </td>
            <td className="px-4 py-2 text-right">
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onExtend(r, 30)}
                  className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] hover:bg-surface-2"
                  title="Push the auto-disable date out by 30 days"
                >
                  +30d
                </button>
                <button
                  type="button"
                  onClick={() => onClear(r)}
                  className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] hover:bg-surface-2"
                  title="Remove the auto-disable date entirely"
                >
                  Cancel timer
                </button>
                <button
                  type="button"
                  onClick={() => onDisableNow(r)}
                  className="rounded border border-danger/40 bg-danger/5 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
                  title="Disable sign-in immediately"
                >
                  Disable now
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Compact "in 3d", "in 12h", "23m" relative time. Used by the
 * expiry chips: a full date is on the title attribute for hover.
 */
function formatRelativeShort(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
