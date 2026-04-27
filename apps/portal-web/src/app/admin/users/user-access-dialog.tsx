'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  Globe,
  Loader2,
  Shield,
  Trash2,
  Users,
  UserX,
  X,
} from 'lucide-react';
import { getItemTypeIcon, getItemTypeLabel } from '@/lib/item-type-icon';
import type { ItemType } from '@gratis-gis/shared-types';

/**
 * Wire shape for GET /admin/users/:id/access. Mirrors
 * UserAccessResponse on the API side -- keep these in sync; the
 * client expects the response exactly as the controller emits.
 */
export interface UserAccessBundle {
  user: {
    id: string;
    username: string;
    fullName: string | null;
    email: string;
    orgRole: 'viewer' | 'contributor' | 'admin';
  };
  owned: Array<UserAccessItemRow>;
  directShared: Array<UserAccessItemRow & {
    permission: string;
    expiresAt: string | null;
  }>;
  groupShared: Array<UserAccessItemRow & {
    permission: string;
    expiresAt: string | null;
    viaGroups: Array<{ id: string; name: string }>;
  }>;
  orgAccessibleCount: number;
  publicAccessibleCount: number;
  groups: Array<{
    id: string;
    name: string;
    description: string | null;
    memberRole: string;
    memberCount: number;
  }>;
  truncated: { owned: boolean; directShared: boolean; groupShared: boolean };
  maxRows: number;
}

interface UserAccessItemRow {
  id: string;
  title: string;
  type: string;
  access: string;
  updatedAt: string;
}

interface Props {
  userId: string;
  username: string;
  onClose: () => void;
}

/**
 * Per-user access dialog (#89). Two tabs:
 *
 *  - Items: every item the user can see, grouped by item type for
 *    readability, with a "via" badge that explains HOW they have
 *    access. Direct shares are bulk-revocable in this tab. Items
 *    visible because of group membership are shown read-only with
 *    a "Manage in group X" button that flips to the Groups tab and
 *    pre-highlights the relevant group's row.
 *
 *  - Groups: every group the user is a member of, with a bulk
 *    "Remove from group" action. The same surface the Items tab
 *    routes to when the admin wants to revoke group-shared access.
 *
 * Open from a small "View access" button on the /admin/users row.
 * Refetches the bundle each time it opens; mutations refetch in
 * place so the counts stay in sync as the admin works.
 */
export function UserAccessDialog({ userId, username, onClose }: Props) {
  const [tab, setTab] = useState<'items' | 'groups'>('items');
  const [bundle, setBundle] = useState<UserAccessBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Selection state -- two independent sets so checkboxes in the
  // Items tab don't collide with checkboxes in the Groups tab.
  const [selectedShares, setSelectedShares] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());

  // When the Items tab routes to "Manage in group X", remember
  // the group id so we can highlight + scroll to it.
  const [highlightGroupId, setHighlightGroupId] = useState<string | null>(null);

  const reload = useMemo(
    () => async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/portal/admin/users/${userId}/access`);
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        setBundle((await r.json()) as UserAccessBundle);
      } catch (e) {
        setError((e as Error).message ?? 'Could not load access.');
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Esc closes; matches the rest of the dialog set.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  function flashMessage(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash((curr) => (curr === msg ? null : curr)), 3500);
  }

  async function bulkRevokeShares() {
    if (!bundle || selectedShares.size === 0) return;
    setBusy(true);
    setError(null);
    const ids = Array.from(selectedShares);
    try {
      // One DELETE per share. The /items/:id/share endpoint takes
      // the principal in the body, so we call it once per item.
      // Concurrency capped at 4 so the API isn't hammered when the
      // admin ticks 50 rows.
      await runBatched(ids, 4, async (itemId) => {
        const r = await fetch(`/api/portal/items/${itemId}/share`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            principalType: 'user',
            principalId: userId,
          }),
        });
        if (!r.ok) {
          throw new Error(`Item ${itemId.slice(0, 8)}: HTTP ${r.status}`);
        }
      });
      flashMessage(
        `Revoked ${ids.length} share${ids.length === 1 ? '' : 's'} from ${username}.`,
      );
      setSelectedShares(new Set());
      await reload();
    } catch (e) {
      setError((e as Error).message ?? 'Could not revoke shares.');
    } finally {
      setBusy(false);
    }
  }

  async function bulkRemoveFromGroups() {
    if (!bundle || selectedGroups.size === 0) return;
    setBusy(true);
    setError(null);
    const ids = Array.from(selectedGroups);
    try {
      await runBatched(ids, 4, async (groupId) => {
        const r = await fetch(
          `/api/portal/groups/${groupId}/members/${userId}`,
          { method: 'DELETE' },
        );
        if (!r.ok) {
          throw new Error(`Group ${groupId.slice(0, 8)}: HTTP ${r.status}`);
        }
      });
      flashMessage(
        `Removed ${username} from ${ids.length} group${ids.length === 1 ? '' : 's'}.`,
      );
      setSelectedGroups(new Set());
      await reload();
    } catch (e) {
      setError((e as Error).message ?? 'Could not remove from groups.');
    } finally {
      setBusy(false);
    }
  }

  function jumpToGroup(groupId: string) {
    setHighlightGroupId(groupId);
    setTab('groups');
    // Scroll the highlighted row into view after the tab swap renders.
    setTimeout(() => {
      const el = document.getElementById(`uad-group-${groupId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Access for ${username}`}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-raised"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink-0">
                What can {username} see?
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Everything visible to this user, with how they have access.
              Use the actions to revoke specific shares or group
              memberships. Org-wide and public items aren&apos;t per-user
              revocable from here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="h-7 w-7 rounded text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border px-3 pt-2">
          <TabButton
            active={tab === 'items'}
            onClick={() => setTab('items')}
            label={
              bundle
                ? `Items (${bundle.owned.length + bundle.directShared.length + bundle.groupShared.length})`
                : 'Items'
            }
          />
          <TabButton
            active={tab === 'groups'}
            onClick={() => setTab('groups')}
            label={bundle ? `Groups (${bundle.groups.length})` : 'Groups'}
          />
        </div>

        {/* Bulk action bar */}
        {tab === 'items' && selectedShares.size > 0 ? (
          <BulkBar
            label={`${selectedShares.size} share${selectedShares.size === 1 ? '' : 's'} selected`}
            actionLabel="Revoke share"
            tone="danger"
            busy={busy}
            onAction={bulkRevokeShares}
            onClear={() => setSelectedShares(new Set())}
          />
        ) : null}
        {tab === 'groups' && selectedGroups.size > 0 ? (
          <BulkBar
            label={`${selectedGroups.size} membership${selectedGroups.size === 1 ? '' : 's'} selected`}
            actionLabel={`Remove ${username} from group`}
            tone="warn"
            busy={busy}
            onAction={bulkRemoveFromGroups}
            onClear={() => setSelectedGroups(new Set())}
          />
        ) : null}

        {flash ? (
          <div className="mx-3 mt-2 inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {flash}
          </div>
        ) : null}
        {error ? (
          <div className="mx-3 mt-2 inline-flex items-start gap-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 text-[11px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !bundle ? (
            <p className="text-sm text-muted">No data.</p>
          ) : tab === 'items' ? (
            <ItemsTab
              bundle={bundle}
              selected={selectedShares}
              onToggleShare={(id) =>
                setSelectedShares((s) => {
                  const next = new Set(s);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onJumpToGroup={jumpToGroup}
            />
          ) : (
            <GroupsTab
              bundle={bundle}
              highlightId={highlightGroupId}
              selected={selectedGroups}
              onToggleGroup={(id) =>
                setSelectedGroups((s) => {
                  const next = new Set(s);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------

function ItemsTab({
  bundle,
  selected,
  onToggleShare,
  onJumpToGroup,
}: {
  bundle: UserAccessBundle;
  selected: Set<string>;
  onToggleShare: (itemId: string) => void;
  onJumpToGroup: (groupId: string) => void;
}) {
  // Group all "items" rows by their item type for readability.
  // Each row carries a `via` discriminator that drives both the
  // badge color and which row actions are available.
  type Row =
    | (UserAccessItemRow & { via: 'owns' })
    | (UserAccessItemRow & {
        via: 'share';
        permission: string;
        expiresAt: string | null;
      })
    | (UserAccessItemRow & {
        via: 'group';
        permission: string;
        expiresAt: string | null;
        viaGroups: Array<{ id: string; name: string }>;
      });
  const rows: Row[] = [
    ...bundle.owned.map((i) => ({ ...i, via: 'owns' as const })),
    ...bundle.directShared.map((s) => ({ ...s, via: 'share' as const })),
    ...bundle.groupShared.map((g) => ({ ...g, via: 'group' as const })),
  ];

  const byType = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  const types = Array.from(byType.keys()).sort();

  return (
    <div className="space-y-3">
      {/* Org / public access summary, since we deliberately don't
          enumerate those rows. The chip lets the admin understand
          the full scope without cluttering the list. */}
      {bundle.orgAccessibleCount + bundle.publicAccessibleCount > 0 ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted">
          <Globe className="mr-1 inline h-3 w-3" />
          Plus <strong>{bundle.orgAccessibleCount.toLocaleString()}</strong>{' '}
          org-wide and{' '}
          <strong>{bundle.publicAccessibleCount.toLocaleString()}</strong> public
          item{bundle.publicAccessibleCount === 1 ? '' : 's'} not listed here.
          These are item-level access settings; per-user revoke isn&apos;t
          possible.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-md border border-border bg-surface-1 px-3 py-6 text-center text-sm text-muted">
          This user owns nothing and has no shares.
        </p>
      ) : (
        types.map((type) => {
          const list = byType.get(type) ?? [];
          const Icon = getItemTypeIcon(type as ItemType);
          const label = getItemTypeLabel(type as ItemType);
          return (
            <section
              key={type}
              className="overflow-hidden rounded-md border border-border"
            >
              <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <Icon className="h-3.5 w-3.5" />
                {label}
                <span className="ml-1 text-muted/60">({list.length})</span>
              </header>
              <ul className="divide-y divide-border">
                {list.map((row) => (
                  <li
                    key={`${row.via}:${row.id}`}
                    className="flex items-center gap-2 px-3 py-2 text-sm"
                  >
                    {row.via === 'share' ? (
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => onToggleShare(row.id)}
                        aria-label={`Select share for ${row.title}`}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    ) : (
                      <span className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <Link
                      href={`/items/${row.id}`}
                      className="flex-1 truncate text-ink-0 hover:text-accent"
                      title={row.title}
                    >
                      {row.title}
                    </Link>
                    <ViaBadge
                      {...(row.via === 'owns'
                        ? { via: 'owns' as const }
                        : row.via === 'share'
                          ? {
                              via: 'share' as const,
                              permission: row.permission,
                              expiresAt: row.expiresAt,
                            }
                          : {
                              via: 'group' as const,
                              permission: row.permission,
                              expiresAt: row.expiresAt,
                              viaGroups: row.viaGroups,
                            })}
                    />
                    {row.via === 'group' ? (
                      <button
                        type="button"
                        onClick={() => onJumpToGroup(row.viaGroups[0]!.id)}
                        className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] hover:bg-surface-2"
                        title={`Manage in group "${row.viaGroups[0]!.name}"`}
                      >
                        Manage in group
                      </button>
                    ) : null}
                    <Link
                      href={`/items/${row.id}`}
                      className="inline-flex items-center text-[11px] text-accent hover:underline"
                      title="Open item"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      {/* Truncation note: when any list capped out, surface it so
          the admin doesn't think they've seen the whole picture. */}
      {bundle.truncated.owned ||
      bundle.truncated.directShared ||
      bundle.truncated.groupShared ? (
        <p className="text-[11px] text-muted">
          Showing the most recent {bundle.maxRows} items per category. If you
          need a complete dump, narrow the search by item type on the items
          list.
        </p>
      ) : null}
    </div>
  );
}

function GroupsTab({
  bundle,
  highlightId,
  selected,
  onToggleGroup,
}: {
  bundle: UserAccessBundle;
  highlightId: string | null;
  selected: Set<string>;
  onToggleGroup: (groupId: string) => void;
}) {
  if (bundle.groups.length === 0) {
    return (
      <p className="rounded-md border border-border bg-surface-1 px-3 py-6 text-center text-sm text-muted">
        This user isn&apos;t a member of any group.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {bundle.groups.map((g) => {
        const isHighlight = highlightId === g.id;
        return (
          <li
            key={g.id}
            id={`uad-group-${g.id}`}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              isHighlight
                ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                : 'border-border bg-surface-1'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(g.id)}
              onChange={() => onToggleGroup(g.id)}
              aria-label={`Select group ${g.name}`}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            <Users className="h-4 w-4 text-muted" />
            <div className="flex flex-1 flex-col truncate">
              <span className="truncate text-ink-0">{g.name}</span>
              {g.description ? (
                <span className="truncate text-[11px] text-muted">
                  {g.description}
                </span>
              ) : null}
            </div>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
              {g.memberRole === 'owner' ? (
                <Shield className="mr-1 inline h-3 w-3" />
              ) : null}
              {g.memberRole}
            </span>
            <span className="text-[11px] text-muted">
              {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
            </span>
            <Link
              href={`/groups/${g.id}`}
              className="inline-flex items-center text-[11px] text-accent hover:underline"
              title="Open group"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

type ViaBadgeProps =
  | { via: 'owns' }
  | { via: 'share'; permission: string; expiresAt: string | null }
  | {
      via: 'group';
      permission: string;
      expiresAt: string | null;
      viaGroups: Array<{ id: string; name: string }>;
    };

function ViaBadge(props: ViaBadgeProps) {
  if (props.via === 'owns') {
    return (
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
        owner
      </span>
    );
  }
  if (props.via === 'share') {
    const expiresAt = props.expiresAt;
    const expired =
      expiresAt !== null && Date.parse(expiresAt) <= Date.now();
    const label = `direct ${props.permission}${
      expiresAt ? (expired ? ' (expired)' : ' (timed)') : ''
    }`;
    return (
      <span
        className={
          expired
            ? 'rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger'
            : 'rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700'
        }
        {...(expiresAt
          ? {
              title: `${expired ? 'Expired' : 'Expires'} ${new Date(expiresAt).toLocaleString()}`,
            }
          : {})}
      >
        {label}
      </span>
    );
  }
  // via === 'group'
  const groupNames = props.viaGroups.map((g) => g.name).join(', ');
  return (
    <span
      className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900"
      title={`Via group: ${groupNames}`}
    >
      via {props.viaGroups.length > 1 ? `${props.viaGroups.length} groups` : `group "${groupNames}"`}
      {props.permission ? ` · ${props.permission}` : ''}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t border border-b-0 px-3 py-1 text-xs font-medium ${
        active
          ? 'border-border bg-surface-1 text-ink-0'
          : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink-1'
      }`}
    >
      {label}
    </button>
  );
}

function BulkBar({
  label,
  actionLabel,
  tone,
  busy,
  onAction,
  onClear,
}: {
  label: string;
  actionLabel: string;
  tone: 'danger' | 'warn';
  busy: boolean;
  onAction: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/20 bg-accent/5 px-4 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-accent">{label}</span>
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
      <button
        type="button"
        onClick={onAction}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
          tone === 'danger'
            ? 'border-danger bg-danger/10 text-danger hover:bg-danger/20'
            : 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
        }`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : tone === 'danger' ? (
          <Trash2 className="h-3.5 w-3.5" />
        ) : (
          <UserX className="h-3.5 w-3.5" />
        )}
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * Bounded-concurrency runner. Mirrors the helper on the
 * housekeeping view; pulled local to avoid a cross-import for a
 * 6-line helper.
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
