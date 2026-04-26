'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Check,
  Globe2,
  Loader2,
  Lock,
  MapPin,
  Trash2,
  Users as UsersIcon,
  User as UserIcon,
} from 'lucide-react';
import type {
  Group,
  ItemAccess,
  ItemShare,
  SharePermission,
} from '@gratis-gis/shared-types';
import {
  PrincipalPicker,
  type PrincipalOption,
} from '@/components/principal-picker';
import {
  ShareGeoLimitDialog,
  type BoundaryOption,
  type ShareGeoLimitSave,
} from './share-geo-limit-dialog';

/** Shares cascaded down from a folder ancestor. Read-only on the
 *  panel; surfaces "Inherited from <Folder>" captions so the user
 *  understands where the access came from and that it can't be
 *  edited here (the relevant action is on the folder itself, not
 *  this item). #44 phase 1c slice 3c. */
export type InheritedShare = ItemShare & {
  fromFolderId: string;
  fromFolderTitle: string;
};

interface Props {
  itemId: string;
  initialAccess: ItemAccess;
  initialShares: ItemShare[];
  /**
   * Shares cascaded from folder ancestors. Rendered as a separate
   * read-only "Inherited" section above the direct shares. Empty
   * array (or omitted) hides the section entirely.
   */
  inheritedShares?: InheritedShare[];
  groups: Pick<Group, 'id' | 'title'>[];
  /**
   * Name or slug of the owning org; used to label the "everyone in your org"
   * visibility option. Pass 'Your organization' as a safe default.
   */
  orgLabel?: string;
}

/**
 * Owner-only sharing controls. Lists current ItemShare rows, lets the owner
 * add a share to a group or a specific user (by user id for now; a user
 * picker component will replace the raw input once /api/users/search exists)
 * and remove existing shares.
 *
 * Mutations go through /api/items/:id/share (POST/DELETE). The page is a
 * server component, so after each mutation we call router.refresh() to
 * re-fetch the server-rendered shares list.
 */
type RowSaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SharingPanel({
  itemId,
  initialAccess,
  initialShares,
  inheritedShares = [],
  groups,
  orgLabel = 'Your organization',
}: Props) {
  const router = useRouter();
  const [access, setAccess] = useState<ItemAccess>(initialAccess);
  const [accessSaveState, setAccessSaveState] = useState<RowSaveState>('idle');
  const [shares, setShares] = useState(initialShares);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function updateAccess(next: ItemAccess) {
    if (next === access) return;
    const prev = access;
    setAccess(next); // optimistic
    setAccessSaveState('saving');
    const res = await fetch(`/api/portal/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access: next }),
    });
    if (!res.ok) {
      setAccess(prev); // revert
      setAccessSaveState('error');
      setError(`Visibility update failed: ${res.status} ${await res.text()}`);
      return;
    }
    setAccessSaveState('saved');
    setTimeout(
      () =>
        setAccessSaveState((s) => (s === 'saved' ? 'idle' : s)),
      1500,
    );
    startTransition(() => router.refresh());
  }

  // Per-row save state, keyed by "<principalType>:<principalId>".
  // Lets us show a spinner / check next to exactly the row being saved,
  // so the rest of the list doesn't flicker on a single-row edit.
  const [rowState, setRowState] = useState<Record<string, RowSaveState>>({});

  const [mode, setMode] = useState<'group' | 'user'>('group');
  const [permission, setPermission] = useState<SharePermission>('view');

  const keyOf = (s: Pick<ItemShare, 'principalType' | 'principalId'>) =>
    `${s.principalType}:${s.principalId}`;

  // Quick lookup sets so the picker can grey out already-shared principals.
  const sharedGroupIds = useMemo(
    () =>
      new Set(
        shares.filter((s) => s.principalType === 'group').map((s) => s.principalId),
      ),
    [shares],
  );
  const sharedUserIds = useMemo(
    () =>
      new Set(
        shares.filter((s) => s.principalType === 'user').map((s) => s.principalId),
      ),
    [shares],
  );

  // Resolve display names for every user principal already in the
  // shares list. Group names come from the `groups` prop the parent
  // hands us, but user names aren't pre-loaded anywhere: without
  // this the row just showed a truncated UUID. Fetched via the same
  // /users?ids= batch endpoint the access matrix uses.
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const userIdsKey = useMemo(
    () =>
      Array.from(sharedUserIds).sort().join(','),
    [sharedUserIds],
  );
  useEffect(() => {
    if (sharedUserIds.size === 0) return;
    const missing = Array.from(sharedUserIds).filter((id) => !userNames[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/portal/users?ids=${encodeURIComponent(missing.join(','))}`,
        );
        if (!r.ok) return;
        const rows = (await r.json()) as Array<{
          id: string;
          username: string;
          fullName: string | null;
        }>;
        if (cancelled) return;
        setUserNames((prev) => {
          const next = { ...prev };
          for (const u of rows) {
            next[u.id] = u.fullName || u.username;
          }
          return next;
        });
      } catch {
        /* non-fatal: row falls back to short id */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIdsKey]);

  async function updateSharePermission(
    share: ItemShare,
    nextPermission: SharePermission,
  ) {
    if (nextPermission === share.permission) return;
    const k = keyOf(share);
    setRowState((m) => ({ ...m, [k]: 'saving' }));
    // Optimistic update so the dropdown stays on the new value while the
    // request is in flight; we revert if it fails.
    setShares((cur) =>
      cur.map((s) =>
        keyOf(s) === k ? { ...s, permission: nextPermission } : s,
      ),
    );
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: share.principalType,
        principalId: share.principalId,
        permission: nextPermission,
      }),
    });
    if (!res.ok) {
      setRowState((m) => ({ ...m, [k]: 'error' }));
      // Revert optimistic change
      setShares((cur) =>
        cur.map((s) =>
          keyOf(s) === k ? { ...s, permission: share.permission } : s,
        ),
      );
      setError(`Update failed: ${res.status} ${await res.text()}`);
      return;
    }
    setRowState((m) => ({ ...m, [k]: 'saved' }));
    // Fade the saved indicator after a moment.
    setTimeout(
      () => setRowState((m) => (m[k] === 'saved' ? { ...m, [k]: 'idle' } : m)),
      1500,
    );
    startTransition(() => router.refresh());
  }

  /**
   * Toggle a share between rowScope='all' and rowScope='own' (#40).
   * Same optimistic-update + revert-on-failure pattern as
   * updateSharePermission. The server's effectiveRowScope helper
   * respects this column for non-owner / non-admin callers.
   */
  async function updateShareRowScope(
    share: ItemShare,
    nextRowScope: 'all' | 'own',
  ) {
    const current =
      (share as ItemShare & { rowScope?: 'all' | 'own' }).rowScope ?? 'all';
    if (nextRowScope === current) return;
    const k = keyOf(share);
    setRowState((m) => ({ ...m, [k]: 'saving' }));
    setShares((cur) =>
      cur.map((s) =>
        keyOf(s) === k
          ? ({ ...s, rowScope: nextRowScope } as ItemShare)
          : s,
      ),
    );
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: share.principalType,
        principalId: share.principalId,
        permission: share.permission,
        rowScope: nextRowScope,
      }),
    });
    if (!res.ok) {
      setRowState((m) => ({ ...m, [k]: 'error' }));
      setShares((cur) =>
        cur.map((s) =>
          keyOf(s) === k
            ? ({ ...s, rowScope: current } as ItemShare)
            : s,
        ),
      );
      setError(`Update failed: ${res.status} ${await res.text()}`);
      return;
    }
    setRowState((m) => ({ ...m, [k]: 'saved' }));
    setTimeout(
      () => setRowState((m) => (m[k] === 'saved' ? { ...m, [k]: 'idle' } : m)),
      1500,
    );
    startTransition(() => router.refresh());
  }

  // Per-share geo-limit editor dialog state. `editingGeoLimit` is the
  // share currently open in the restrict-to-area dialog (null when
  // the dialog is closed). `geoLimitSaving` gates the save button
  // while the POST is in flight.
  const [editingGeoLimit, setEditingGeoLimit] = useState<ItemShare | null>(
    null,
  );
  const [geoLimitSaving, setGeoLimitSaving] = useState(false);

  // Org's geo_boundary item library, populated lazily the first time
  // the dialog opens. Lets the admin pick a curated boundary instead
  // of pasting GeoJSON. Empty array is the default and renders an
  // appropriate "no boundaries" hint inside the dialog.
  const [boundaries, setBoundaries] = useState<BoundaryOption[]>([]);
  const [boundariesLoaded, setBoundariesLoaded] = useState(false);

  useEffect(() => {
    if (editingGeoLimit && !boundariesLoaded) {
      void (async () => {
        try {
          const res = await fetch('/api/portal/items?type=geo_boundary');
          if (!res.ok) return;
          const items = (await res.json()) as Array<{
            id: string;
            title: string;
          }>;
          setBoundaries(
            items.map((i) => ({ id: i.id, title: i.title })),
          );
        } finally {
          setBoundariesLoaded(true);
        }
      })();
    }
  }, [editingGeoLimit, boundariesLoaded]);

  async function saveGeoLimit(
    share: ItemShare,
    next: ShareGeoLimitSave,
  ) {
    setError(null);
    setGeoLimitSaving(true);
    try {
      // The share endpoint is idempotent on (itemId, principalType,
      // principalId), so re-POSTing with the existing permission and
      // the new clip values updates only those columns. Null on either
      // field clears it; the API enforces mutual exclusivity.
      const res = await fetch(`/api/portal/items/${itemId}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalType: share.principalType,
          principalId: share.principalId,
          permission: share.permission,
          geoLimit: next.geoLimit,
          geoBoundaryId: next.geoBoundaryId,
        }),
      });
      if (!res.ok) {
        setError(`Could not save restriction: ${res.status} ${await res.text()}`);
        return;
      }
      const updated: ItemShare = await res.json();
      setShares((cur) =>
        cur.map((s) =>
          s.principalType === updated.principalType &&
          s.principalId === updated.principalId
            ? updated
            : s,
        ),
      );
      setEditingGeoLimit(null);
      startTransition(() => router.refresh());
    } finally {
      setGeoLimitSaving(false);
    }
  }

  async function addShare(
    principalType: 'group' | 'user',
    principalId: string,
  ) {
    setError(null);
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalType, principalId, permission }),
    });
    if (!res.ok) {
      setError(`Share failed: ${res.status} ${await res.text()}`);
      return;
    }
    const added: ItemShare = await res.json();
    setShares((cur) => {
      const filtered = cur.filter(
        (s) =>
          !(
            s.principalType === added.principalType &&
            s.principalId === added.principalId
          ),
      );
      return [...filtered, added];
    });
    startTransition(() => router.refresh());
  }

  // Group search: purely client-side against the already-loaded list.
  const searchGroups = useCallback(
    (q: string): PrincipalOption[] => {
      const needle = q.trim().toLowerCase();
      const base = needle
        ? groups.filter((g) => g.title.toLowerCase().includes(needle))
        : groups;
      return base.map((g) => {
        const already = sharedGroupIds.has(g.id);
        const opt: PrincipalOption = { id: g.id, title: g.title };
        if (already) {
          opt.disabled = true;
          opt.disabledReason = 'already shared';
        }
        return opt;
      });
    },
    [groups, sharedGroupIds],
  );

  // User search: hits the org-scoped /api/users endpoint. Debouncing is
  // handled inside the picker.
  const searchUsers = useCallback(
    async (q: string): Promise<PrincipalOption[]> => {
      const url = `/api/portal/users${q ? `?q=${encodeURIComponent(q)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const rows: Array<{
        id: string;
        username: string;
        fullName: string;
        avatarUrl: string | null;
      }> = await res.json();
      return rows.map((u) => {
        const already = sharedUserIds.has(u.id);
        const opt: PrincipalOption = {
          id: u.id,
          title: u.fullName || u.username,
          subtitle: u.username,
          imageUrl: u.avatarUrl,
        };
        if (already) {
          opt.disabled = true;
          opt.disabledReason = 'already shared';
        }
        return opt;
      });
    },
    [sharedUserIds],
  );

  async function removeShare(share: ItemShare) {
    setError(null);
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: share.principalType,
        principalId: share.principalId,
      }),
    });
    if (!res.ok) {
      setError(`Unshare failed: ${res.status} ${await res.text()}`);
      return;
    }
    setShares((cur) =>
      cur.filter(
        (s) =>
          !(
            s.principalType === share.principalType &&
            s.principalId === share.principalId
          ),
      ),
    );
    startTransition(() => router.refresh());
  }

  const visibilityOptions: Array<{
    value: ItemAccess;
    label: string;
    desc: string;
    Icon: typeof Lock;
  }> = [
    {
      value: 'private',
      label: 'Private',
      desc: 'Only you and people you share with below.',
      Icon: Lock,
    },
    {
      value: 'org',
      label: orgLabel,
      desc:
        orgLabel === 'Your organization'
          ? 'Everyone with a login in your organization can see this.'
          : `Everyone with a login at ${orgLabel} can see this.`,
      Icon: Building2,
    },
    {
      value: 'public',
      label: 'Public',
      desc: 'Anyone on the internet, no login required.',
      Icon: Globe2,
    },
  ];
  const currentOption = visibilityOptions.find((o) => o.value === access)!;

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Visibility
          </h3>
          <span className="inline-flex h-5 w-5 items-center justify-center" aria-live="polite">
            {accessSaveState === 'saving' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
            ) : accessSaveState === 'saved' ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : null}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Visibility">
          {visibilityOptions.map(({ value, label, desc, Icon }) => {
            const selected = access === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => updateAccess(value)}
                disabled={pending}
                className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-50 ${
                  selected
                    ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${selected ? 'text-accent' : 'text-muted'}`}
                  />
                  <span className="text-sm font-medium text-ink-1">{label}</span>
                </div>
                <span className="text-xs text-muted">{desc}</span>
              </button>
            );
          })}
        </div>
        {access !== 'private' ? (
          <p className="mt-3 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-ink-1">
            <strong className="font-medium">{currentOption.label}</strong>{' '}
            {access === 'org'
              ? 'can already see this item. Shares below only matter for granting edit or admin permission on top of that.'
              : 'means anyone on the internet can view this. Shares below only matter for granting edit or admin permission.'}
          </p>
        ) : null}
      </div>

      {/* Inherited-shares display retired 2026-04-26.
          Folder shares no longer cascade to child items (#63);
          surfacing an "Inherited from <folder>" caption would
          describe a grant that doesn't take effect. The
          inheritedShares prop and InheritedShare type are still
          accepted by the API for now so external callers don't
          break, but nothing is rendered. The "Share all items in
          this folder" bulk action on the folder page (#64) is
          how authors apply a single grant to many items at once;
          each item ends up with its own real share row that
          appears in the regular shares list below.
          The `inheritedShares` prop is intentionally still in the
          signature so tests / callers don't have to update at the
          same beat as the dialog change. */}

      <div className="px-4 pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Shares
        </h3>
      </div>
      {shares.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">
          No explicit shares yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shares.map((share) => {
            const groupTitle = groups.find(
              (g) => g.id === share.principalId,
            )?.title;
            return (
              <li
                key={`${share.principalType}:${share.principalId}`}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {share.principalType === 'group' ? (
                    <UsersIcon className="h-4 w-4 shrink-0 text-muted" />
                  ) : (
                    <UserIcon className="h-4 w-4 shrink-0 text-muted" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink-1">
                      {share.principalType === 'group'
                        ? (groupTitle ?? share.principalId.slice(0, 8))
                        : (userNames[share.principalId] ??
                          share.principalId.slice(0, 8))}
                    </div>
                    <div className="text-xs text-muted">
                      {share.principalType}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    value={share.permission}
                    onChange={(e) =>
                      updateSharePermission(
                        share,
                        e.target.value as SharePermission,
                      )
                    }
                    disabled={pending}
                    aria-label="Change permission"
                    className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                  >
                    <option value="view">can view</option>
                    <option value="download">can download</option>
                    <option value="edit">can edit</option>
                    <option value="admin">can admin</option>
                  </select>
                  {/* Row scope (#40). Narrows the share to features
                      the principal themselves created. Hidden for
                      'admin' permission since admins always see
                      everything anyway and the picker would be
                      misleading. */}
                  {share.permission !== 'admin' ? (
                    <select
                      value={
                        (share as ItemShare & { rowScope?: 'all' | 'own' }).rowScope ?? 'all'
                      }
                      onChange={(e) =>
                        updateShareRowScope(
                          share,
                          e.target.value as 'all' | 'own',
                        )
                      }
                      disabled={pending}
                      aria-label="Row scope"
                      title="What can they see / edit?"
                      className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                    >
                      <option value="all">all features</option>
                      <option value="own">only theirs</option>
                    </select>
                  ) : null}
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center"
                    aria-live="polite"
                  >
                    {rowState[keyOf(share)] === 'saving' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
                    ) : rowState[keyOf(share)] === 'saved' ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingGeoLimit(share)}
                    disabled={pending}
                    title={
                      share.geoLimit || share.geoBoundaryId
                        ? 'Edit geographic restriction'
                        : 'Restrict to a geographic area'
                    }
                    aria-label="Restrict to area"
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-50 ${
                      share.geoLimit || share.geoBoundaryId
                        ? 'bg-accent/10 text-accent hover:bg-accent/15'
                        : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                    }`}
                  >
                    <MapPin className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeShare(share)}
                    disabled={pending}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                    aria-label="Remove share"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editingGeoLimit ? (
        <ShareGeoLimitDialog
          principalLabel={
            editingGeoLimit.principalType === 'group'
              ? (groups.find((g) => g.id === editingGeoLimit.principalId)
                  ?.title ?? editingGeoLimit.principalId.slice(0, 8))
              : (userNames[editingGeoLimit.principalId] ??
                editingGeoLimit.principalId.slice(0, 8))
          }
          initialGeoLimit={editingGeoLimit.geoLimit ?? null}
          initialGeoBoundaryId={editingGeoLimit.geoBoundaryId ?? null}
          boundaries={boundaries}
          saving={geoLimitSaving}
          onClose={() => setEditingGeoLimit(null)}
          onSave={(next) => saveGeoLimit(editingGeoLimit, next)}
        />
      ) : null}

      <div className="border-t border-border p-4">
        <div className="flex flex-wrap items-start gap-2">
          <div className="inline-flex rounded-md border border-border bg-surface-2">
            <button
              type="button"
              onClick={() => setMode('group')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ${mode === 'group' ? 'bg-accent text-accent-foreground rounded-md' : 'text-muted'}`}
            >
              <UsersIcon className="h-3.5 w-3.5" />
              Group
            </button>
            <button
              type="button"
              onClick={() => setMode('user')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ${mode === 'user' ? 'bg-accent text-accent-foreground rounded-md' : 'text-muted'}`}
            >
              <UserIcon className="h-3.5 w-3.5" />
              User
            </button>
          </div>

          {/*
            The picker submits directly on selection so there's no separate
            "Add share" button. Principals already on the item show up
            greyed-out in the list so the user knows why the row doesn't
            pop in afterwards. Permission can be adjusted before picking.
          */}
          <div className="min-w-[18rem] flex-1">
            {mode === 'group' ? (
              <PrincipalPicker
                key="group-picker"
                placeholder="Search groups..."
                search={searchGroups}
                onPick={(opt) => addShare('group', opt.id)}
                emptyInitialMessage={
                  groups.length === 0
                    ? 'No groups yet. Create one from /groups.'
                    : 'Start typing to filter groups.'
                }
              />
            ) : (
              <PrincipalPicker
                key="user-picker"
                placeholder="Search people in your org..."
                search={searchUsers}
                onPick={(opt) => addShare('user', opt.id)}
                emptyInitialMessage="Start typing a name or username."
              />
            )}
          </div>

          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as SharePermission)}
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="view">can view</option>
            <option value="edit">can edit</option>
            <option value="admin">can admin</option>
          </select>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
