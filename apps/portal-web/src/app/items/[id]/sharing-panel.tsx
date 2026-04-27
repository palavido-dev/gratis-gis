'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
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
  ItemType,
  SharePermission,
} from '@gratis-gis/shared-types';
import {
  PrincipalPicker,
  type PrincipalOption,
} from '@/components/principal-picker';
import { ShareExpiryPicker } from '@/components/share-expiry-picker';
import {
  ShareGeoLimitDialog,
  type BoundaryOption,
  type ShareGeoLimitSave,
} from './share-geo-limit-dialog';
import {
  loadEditorDependencyChain,
  principalHasItemAccess,
  type EditorDependencyNode,
} from '@/lib/editor-dependencies';
import { getItemTypeLabel } from '@/lib/item-type-icon';
import { ItemAccessMatrix } from '@/components/item-access-matrix';

interface Props {
  itemId: string;
  /**
   * Item type. Composite types (today: editor) trigger a
   * dependency-access pre-check before each share is created --
   * sharing an editor without granting view on its referenced map
   * + target data_layers leaves the sharee staring at a broken
   * runtime. The pre-check refuses to proceed silently; the
   * author either cancels the share or grants view on every
   * missing dependency. Non-composite types skip the check.
   */
  itemType: ItemType;
  initialAccess: ItemAccess;
  initialShares: ItemShare[];
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
  itemType,
  initialAccess,
  initialShares,
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

  // Editor share-time hard prompt (#editor sharing slice 2). When
  // an editor item is being shared, we first audit the principal
  // against the editor's full dependency chain (referenced map +
  // basemap + map's layers + target data_layers). If any
  // dependency is invisible to the principal, a confirm modal
  // forces the author to either cancel the share or grant view on
  // every missing dependency. Skipping the gap is intentionally
  // not an option: a missing dep means the runtime breaks for
  // that user, and a silent broken share is worse than a clear
  // refusal at share time.
  //
  // The dep chain is fetched lazily on the first editor share
  // attempt and memoized; subsequent shares in the same session
  // reuse it. depCacheRef stores both the chain and the in-flight
  // promise so a rapid double-pick doesn't race.
  const [pendingShare, setPendingShare] = useState<{
    principalType: 'user' | 'group';
    principalId: string;
    principalName: string;
    missing: EditorDependencyNode[];
  } | null>(null);
  const [confirmingShare, setConfirmingShare] = useState(false);
  const depChainRef = useRef<{
    promise: Promise<EditorDependencyNode[]> | null;
    chain: EditorDependencyNode[] | null;
  }>({ promise: null, chain: null });
  const [auditingPrincipal, setAuditingPrincipal] = useState<string | null>(
    null,
  );

  // Editor sharing slice 3. Mounts the ItemAccessMatrix to audit
  // pre-existing shares that were created before slice 2 (or
  // before a target was added to the editor). depChainSnapshot is
  // the materialized chain used by the matrix; we keep it in
  // state separately from depChainRef.current.chain so React re-
  // renders when the chain refreshes after a grant. Memberships
  // are batch-loaded for every user principal on the editor's
  // share list when the surface mounts.
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [depChainSnapshot, setDepChainSnapshot] = useState<
    EditorDependencyNode[] | null
  >(null);
  const [matrixMemberships, setMatrixMemberships] = useState<
    Record<string, string[]>
  >({});
  const [matrixPrincipalNames, setMatrixPrincipalNames] = useState<
    Record<string, string>
  >({});

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

  // Editor-only: load the dependency chain + group memberships +
  // user names for every principal already on the editor's share
  // list. Drives the inline gap-badge and the ItemAccessMatrix
  // surface (slice 3). Re-runs whenever the editor's share list
  // changes so a freshly-added share's gap state shows up
  // immediately without a full page refresh.
  const userPrincipalKey = useMemo(
    () =>
      shares
        .filter((s) => s.principalType === 'user')
        .map((s) => s.principalId)
        .sort()
        .join(','),
    [shares],
  );
  useEffect(() => {
    if (itemType !== 'editor') return;
    let cancelled = false;
    (async () => {
      try {
        const { nodes } = await loadEditorDependencyChain(itemId);
        if (cancelled) return;
        depChainRef.current.chain = nodes;
        setDepChainSnapshot(nodes);
      } catch {
        /* non-fatal: badge won't render but the panel still works */
      }
      const userIds = userPrincipalKey
        ? userPrincipalKey.split(',').filter(Boolean)
        : [];
      if (userIds.length > 0) {
        try {
          const r = await fetch(
            `/api/portal/users?ids=${encodeURIComponent(userIds.join(','))}`,
          );
          if (r.ok && !cancelled) {
            const rows = (await r.json()) as Array<{
              id: string;
              username: string;
              fullName: string | null;
              groupIds?: string[];
            }>;
            const memberships: Record<string, string[]> = {};
            const names: Record<string, string> = {};
            for (const u of rows) {
              memberships[u.id] = u.groupIds ?? [];
              names[u.id] = u.fullName || u.username;
            }
            setMatrixMemberships(memberships);
            setMatrixPrincipalNames((prev) => ({ ...prev, ...names }));
          }
        } catch {
          /* non-fatal: gaps over-count when memberships missing */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, itemType, userPrincipalKey]);

  // Pre-built principal list for the matrix. One row per share on
  // the editor; the principal's display name comes from
  // matrixPrincipalNames (users) or the groups prop (groups).
  // Self-shares are filtered out of the matrix the same way
  // ItemSharingIndicator filters them: nothing to grant to
  // yourself.
  const matrixPrincipals = useMemo(() => {
    return shares.map((s) => {
      const fallback = `${s.principalType} ${s.principalId.slice(0, 8)}`;
      let name: string;
      if (s.principalType === 'user') {
        name = matrixPrincipalNames[s.principalId] ?? fallback;
      } else {
        name =
          groups.find((g) => g.id === s.principalId)?.title ?? fallback;
      }
      return {
        type: s.principalType as 'user' | 'group',
        id: s.principalId,
        name,
      };
    });
  }, [shares, matrixPrincipalNames, groups]);

  // hasAccess closure for the matrix. Memoized so the matrix's
  // own useMemo of `gaps` doesn't churn on unrelated re-renders.
  const matrixHasAccess = useCallback(
    (depItemId: string, principal: { type: 'user' | 'group'; id: string }) => {
      const node = depChainSnapshot?.find((n) => n.id === depItemId);
      if (!node) return true; // unknown dep: no badge, no fix
      return principalHasItemAccess(node, principal, matrixMemberships);
    },
    [depChainSnapshot, matrixMemberships],
  );

  // Total open gaps. Drives the inline badge above the share list
  // ("3 sharees can't see all dependencies") and the prompt to
  // open the matrix.
  const dependencyGapCount = useMemo(() => {
    if (!depChainSnapshot || matrixPrincipals.length === 0) return 0;
    let total = 0;
    for (const dep of depChainSnapshot) {
      for (const p of matrixPrincipals) {
        if (!principalHasItemAccess(dep, p, matrixMemberships)) total += 1;
      }
    }
    return total;
  }, [depChainSnapshot, matrixPrincipals, matrixMemberships]);

  // Grant view permission on a dependency item. Used by the
  // ItemAccessMatrix's per-cell + bulk-grant actions. On success
  // we splice the new share into the local snapshot so the cell
  // flips to ✓ without re-fetching the whole chain.
  const grantDependencyAccess = useCallback(
    async (
      depItemId: string,
      principal: { type: 'user' | 'group'; id: string; name: string },
    ) => {
      const res = await fetch(`/api/portal/items/${depItemId}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalType: principal.type,
          principalId: principal.id,
          permission: 'view',
        }),
      });
      if (!res.ok) {
        throw new Error(
          `${res.status} ${(await res.text()) || 'grant failed'}`,
        );
      }
      const added = (await res.json()) as ItemShare;
      setDepChainSnapshot((prev) => {
        if (!prev) return prev;
        return prev.map((node) => {
          if (node.id !== depItemId) return node;
          // Replace any pre-existing row for the same principal,
          // then append. Same dedupe shape as the editor's own
          // share-list update.
          const filtered = node.shares.filter(
            (s) =>
              !(
                s.principalType === added.principalType &&
                s.principalId === added.principalId
              ),
          );
          return { ...node, shares: [...filtered, added] };
        });
      });
    },
    [],
  );

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
   * Set / clear a share's expires_at (#84). Same optimistic-update
   * pattern. Pass null to clear, an ISO date string to set. After
   * the timestamp the share is filtered out at request time and
   * eventually swept by housekeeping cron.
   */
  async function updateShareExpiry(
    share: ItemShare,
    nextExpiresAt: string | null,
  ) {
    const current =
      (share as ItemShare & { expiresAt?: string | null }).expiresAt ?? null;
    if (nextExpiresAt === current) return;
    const k = keyOf(share);
    setRowState((m) => ({ ...m, [k]: 'saving' }));
    setShares((cur) =>
      cur.map((s) =>
        keyOf(s) === k
          ? ({ ...s, expiresAt: nextExpiresAt } as ItemShare)
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
        expiresAt: nextExpiresAt,
      }),
    });
    if (!res.ok) {
      setRowState((m) => ({ ...m, [k]: 'error' }));
      setShares((cur) =>
        cur.map((s) =>
          keyOf(s) === k
            ? ({ ...s, expiresAt: current } as ItemShare)
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

  /** Lazily fetch + cache the editor's full dependency chain. */
  async function loadDependencyChainCached(): Promise<
    EditorDependencyNode[]
  > {
    if (depChainRef.current.chain) return depChainRef.current.chain;
    if (depChainRef.current.promise) return depChainRef.current.promise;
    const p = (async () => {
      const { nodes } = await loadEditorDependencyChain(itemId);
      depChainRef.current.chain = nodes;
      depChainRef.current.promise = null;
      return nodes;
    })();
    depChainRef.current.promise = p;
    return p;
  }

  /**
   * Pre-share dependency audit for editor items. Fetches the
   * principal's group memberships (users only; groups have no
   * memberships of their own here), runs the full chain through
   * `principalHasItemAccess`, and either:
   *   - opens the hard-prompt modal when there are gaps, or
   *   - falls through to addShare() when the principal already
   *     has access to every dependency.
   * Non-editor item types skip the audit entirely.
   *
   * The modal does not let the author "skip" gaps because a
   * skipped gap means a broken runtime for the sharee. Two
   * choices, no third path: cancel, or grant view on every
   * missing dep and proceed.
   */
  async function intentShare(
    principalType: 'group' | 'user',
    principalId: string,
    principalName: string,
  ) {
    setError(null);
    if (itemType !== 'editor') {
      void addShare(principalType, principalId);
      return;
    }
    const principalKey = `${principalType}:${principalId}`;
    setAuditingPrincipal(principalKey);
    try {
      const chain = await loadDependencyChainCached();
      if (chain.length === 0) {
        await addShare(principalType, principalId);
        return;
      }
      let memberships: Record<string, string[]> = {};
      if (principalType === 'user') {
        try {
          const r = await fetch(
            `/api/portal/users?ids=${encodeURIComponent(principalId)}`,
          );
          if (r.ok) {
            const rows = (await r.json()) as Array<{
              id: string;
              groupIds?: string[];
            }>;
            for (const u of rows) memberships[u.id] = u.groupIds ?? [];
          }
        } catch {
          /* non-fatal: gap detection treats user as no-groups, which is
             the conservative default (more gaps shown, not fewer) */
        }
      }
      const missing = chain.filter(
        (n) =>
          !principalHasItemAccess(
            n,
            { type: principalType, id: principalId },
            memberships,
          ),
      );
      if (missing.length === 0) {
        await addShare(principalType, principalId);
        return;
      }
      setPendingShare({ principalType, principalId, principalName, missing });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Dependency audit failed: ${err.message}`
          : 'Dependency audit failed.',
      );
    } finally {
      setAuditingPrincipal(null);
    }
  }

  /**
   * "Share + grant view on missing items" path of the hard
   * prompt. Issues a view-share POST against each missing
   * dependency, then calls addShare on the editor. Done in
   * sequence (not parallel) so a downstream failure on one
   * dep grant surfaces a usable error rather than a partial
   * orchestration. The dep cache is invalidated on success
   * because subsequent gap audits should see the freshly-
   * granted shares.
   */
  async function confirmGrantAndShare() {
    if (!pendingShare) return;
    setConfirmingShare(true);
    setError(null);
    try {
      for (const dep of pendingShare.missing) {
        const res = await fetch(`/api/portal/items/${dep.id}/share`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            principalType: pendingShare.principalType,
            principalId: pendingShare.principalId,
            permission: 'view',
          }),
        });
        if (!res.ok) {
          throw new Error(
            `Grant on "${dep.title}" failed: ${res.status} ${await res.text()}`,
          );
        }
      }
      await addShare(
        pendingShare.principalType,
        pendingShare.principalId,
      );
      depChainRef.current = { promise: null, chain: null };
      setPendingShare(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Grant or share failed.',
      );
    } finally {
      setConfirmingShare(false);
    }
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
      {itemType === 'editor' &&
      depChainSnapshot &&
      matrixPrincipals.length > 0 ? (
        <div
          className={`flex items-center justify-between gap-3 border-b px-4 py-2.5 ${
            dependencyGapCount > 0
              ? 'border-amber-200 bg-amber-50'
              : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <div className="flex items-start gap-2 text-xs">
            <AlertTriangle
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                dependencyGapCount > 0 ? 'text-amber-700' : 'text-emerald-700'
              }`}
            />
            <div>
              <div
                className={`font-medium ${
                  dependencyGapCount > 0 ? 'text-amber-900' : 'text-emerald-900'
                }`}
              >
                {dependencyGapCount > 0
                  ? `${dependencyGapCount} dependency access gap${
                      dependencyGapCount === 1 ? '' : 's'
                    } across ${matrixPrincipals.length} sharee${
                      matrixPrincipals.length === 1 ? '' : 's'
                    }`
                  : 'All sharees can see every dependency'}
              </div>
              <div
                className={
                  dependencyGapCount > 0 ? 'text-amber-800' : 'text-emerald-800'
                }
              >
                {dependencyGapCount > 0
                  ? 'Sharees missing access on a dependency item will hit a broken runtime when they open this editor.'
                  : 'The referenced map, basemap, layer items, and target data layers are all visible to your sharees.'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMatrixOpen(true)}
            className={`shrink-0 rounded border px-2 py-1 text-xs font-medium ${
              dependencyGapCount > 0
                ? 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100'
                : 'border-emerald-300 bg-white text-emerald-900 hover:bg-emerald-100'
            }`}
          >
            {dependencyGapCount > 0 ? 'Review and grant' : 'Open access matrix'}
          </button>
        </div>
      ) : null}
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
                  <ShareExpiryPicker
                    value={
                      (share as ItemShare & { expiresAt?: string | null })
                        .expiresAt ?? null
                    }
                    onChange={(next) => void updateShareExpiry(share, next)}
                    disabled={pending}
                  />
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
                onPick={(opt) =>
                  void intentShare('group', opt.id, opt.title)
                }
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
                onPick={(opt) =>
                  void intentShare('user', opt.id, opt.title)
                }
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
        {auditingPrincipal ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking dependency access...
          </p>
        ) : null}
      </div>

      {itemType === 'editor' && depChainSnapshot ? (
        <ItemAccessMatrix
          open={matrixOpen}
          title="Editor item access"
          items={depChainSnapshot.map((node) => ({
            id: node.id,
            title: node.title,
            type: node.type,
            rationale: node.rationale,
          }))}
          principals={matrixPrincipals}
          hasAccess={(itemId, p) => matrixHasAccess(itemId, p)}
          onGrantItemAccess={async (depItemId, principal) => {
            await grantDependencyAccess(depItemId, principal);
          }}
          onClose={() => setMatrixOpen(false)}
          canManage
        />
      ) : null}

      {pendingShare ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface-1 shadow-raised">
            <div className="flex items-start gap-3 border-b border-border px-4 py-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink-0">
                  Grant access to dependencies?
                </h2>
                <p className="mt-1 text-xs text-muted">
                  <span className="font-medium text-ink-1">
                    {pendingShare.principalName}
                  </span>{' '}
                  cannot see {pendingShare.missing.length} item
                  {pendingShare.missing.length === 1 ? '' : 's'} this
                  editor depends on. Without view access on each one,
                  the editor will fail to load when they open it.
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ul className="space-y-1.5">
                {pendingShare.missing.map((dep) => (
                  <li
                    key={dep.id}
                    className="rounded border border-amber-200 bg-amber-50 px-3 py-2"
                  >
                    <div className="text-sm font-medium text-ink-1">
                      {dep.title}
                    </div>
                    <div className="text-[11px] uppercase tracking-wide text-amber-800">
                      {getItemTypeLabel(dep.type)}
                      {dep.rationale ? ` · ${dep.rationale}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
              <button
                type="button"
                disabled={confirmingShare}
                onClick={() => setPendingShare(null)}
                className="inline-flex h-8 items-center rounded border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                Cancel share
              </button>
              <button
                type="button"
                disabled={confirmingShare}
                onClick={() => void confirmGrantAndShare()}
                className="inline-flex h-8 items-center gap-1 rounded bg-amber-600 px-3 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {confirmingShare ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Share + grant view on {pendingShare.missing.length} item
                {pendingShare.missing.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
