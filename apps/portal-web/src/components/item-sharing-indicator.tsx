// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Building2,
  ExternalLink,
  Globe2,
  Loader2,
  Lock,
  Trash2,
  Users as UsersIcon,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type {
  ItemAccess,
  ItemShare,
  SharePermission,
} from '@gratis-gis/shared-types';

import { PublicCascadeDialog } from './public-cascade-dialog';
import { PublicCascadeRevertDialog } from './public-cascade-revert-dialog';
import { useT } from '@/lib/i18n/locale-context';

type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Compact sharing indicator for rendering inline with an item card or
 * list row. Shows access level (Private / Org / Public) plus a count
 * of explicit share rows, and opens a popover with:
 *
 *   - inline access-level switcher (PATCH /api/items/:id)
 *   - list of explicit shares with quick-remove buttons
 *   - a "manage" link through to the full sharing panel on the detail
 *     page for everything else (adding new principals, changing
 *     permissions, org-level bulk operations)
 *
 * Intentionally lean: keeps the click targets obvious, persists the
 * state the user expects, and bounces back to the full panel for
 * anything advanced so we don't reimplement the sharing UI twice.
 */
interface Props {
  itemId: string;
  itemTitle: string;
  access: ItemAccess;
  shares: ItemShare[];
  /** Whether the current user has rights to edit sharing (owner/admin). */
  canManage: boolean;
  /** Self user id: used to hide "shared with you (yourself)" noise. */
  currentUserId: string;
  /** Prevents the parent <a> from navigating when the chip is clicked. */
  stopParentLink?: boolean;
}

const ACCESS_META: Record<
  ItemAccess,
  { Icon: LucideIcon; chipBg: string; chipText: string }
> = {
  private: {
    Icon: Lock,
    chipBg: 'bg-surface-2',
    chipText: 'text-ink-1',
  },
  org: {
    Icon: Building2,
    chipBg: 'bg-info/15',
    chipText: 'text-info',
  },
  public: {
    Icon: Globe2,
    chipBg: 'bg-success/15',
    chipText: 'text-success',
  },
};

/** User-facing label for each access tier, resolved through i18n. */
function accessLabel(t: TranslateFn, lvl: ItemAccess): string {
  return t(`sharing.access.${lvl}`);
}

interface PrincipalMeta {
  id: string;
  label: string;
  sublabel?: string;
}

/** Best-effort name resolution for principals. We batch-fetch users + groups
 *  once the popover is opened so we don't pay the cost for every card
 *  in a large list. */
async function resolveNames(
  shares: ItemShare[],
): Promise<{ users: Record<string, PrincipalMeta>; groups: Record<string, PrincipalMeta> }> {
  const userIds = Array.from(
    new Set(shares.filter((s) => s.principalType === 'user').map((s) => s.principalId)),
  );
  const groupIds = Array.from(
    new Set(shares.filter((s) => s.principalType === 'group').map((s) => s.principalId)),
  );

  const users: Record<string, PrincipalMeta> = {};
  const groups: Record<string, PrincipalMeta> = {};

  const tasks: Array<Promise<void>> = [];

  if (userIds.length > 0) {
    tasks.push(
      (async () => {
        try {
          const res = await fetch(
            `/api/portal/users?ids=${encodeURIComponent(userIds.join(','))}`,
          );
          if (!res.ok) return;
          const rows = (await res.json()) as Array<{
            id: string;
            fullName: string | null;
            username: string;
          }>;
          for (const u of rows) {
            users[u.id] = {
              id: u.id,
              label: u.fullName || u.username,
              sublabel: u.username,
            };
          }
        } catch {
          /* non-fatal; rows fall back to id prefix */
        }
      })(),
    );
  }

  if (groupIds.length > 0) {
    tasks.push(
      (async () => {
        try {
          const res = await fetch(`/api/portal/groups`);
          if (!res.ok) return;
          const all = (await res.json()) as Array<{ id: string; title: string }>;
          for (const g of all) {
            if (groupIds.includes(g.id)) {
              groups[g.id] = { id: g.id, label: g.title };
            }
          }
        } catch {
          /* non-fatal */
        }
      })(),
    );
  }

  await Promise.all(tasks);
  return { users, groups };
}

export function ItemSharingIndicator({
  itemId,
  itemTitle,
  access,
  shares,
  canManage,
  currentUserId,
  stopParentLink,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [currentAccess, setCurrentAccess] = useState<ItemAccess>(access);
  const [currentShares, setCurrentShares] = useState<ItemShare[]>(shares);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #310: after a successful flip to access='public', open the
  // cascade-prompt modal so the author can also flip every
  // referenced item to public without having to navigate to each
  // one individually.
  const [cascadeOpen, setCascadeOpen] = useState(false);
  // #334: inverse cascade. After a flip OUT of access='public', open
  // the revert-prompt modal so the author can also downgrade every
  // public dep that was only public because of THIS parent. The
  // server filters out deps still needed by another public item.
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertTarget, setRevertTarget] = useState<ItemAccess>('org');
  // #84: pre-public tier captured at flip time so the cascade
  // dialog's Cancel button can revert the parent if the author
  // changes their mind after reading the dependency list.
  const [preCascadeAccess, setPreCascadeAccess] =
    useState<ItemAccess>('private');
  const [principalMeta, setPrincipalMeta] = useState<{
    users: Record<string, PrincipalMeta>;
    groups: Record<string, PrincipalMeta>;
  }>({ users: {}, groups: {} });
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Popover is rendered via a portal so it escapes ancestor
  // `overflow: hidden` / stacking contexts (the card's <a>, the list's
  // rounded border). Fixed position driven by the button's current
  // bounding rect; recomputed on scroll + resize while open.
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    right: number;
  } | null>(null);

  // Sync from props (in case the parent re-fetches and hands new data).
  useEffect(() => {
    setCurrentAccess(access);
  }, [access]);
  useEffect(() => {
    setCurrentShares(shares);
  }, [shares]);

  // Show every share row, including a share whose principal is the
  // current viewer. Previously we filtered self-shares out as
  // "don't tell the user they shared with themselves", but that
  // filter mis-fires for sharees: when a contributor (not the
  // owner) opens the popover on someone else's item, the share row
  // TO them is exactly what's granting visibility, and hiding it
  // made the popover read "0 shares" while the chip count agreed
  // and lied. We keep the row visible and tag it "(you)" inside
  // SharingRow; the remove button is hidden for self-shares
  // regardless of
  // canManage so users don't accidentally yank their own access.
  const visibleShares = currentShares;

  const shareCount = visibleShares.length;
  const meta = ACCESS_META[currentAccess];

  // Load names the first time the popover opens: avoid paying the
  // cost for cards the user never interacts with.
  const didLoadNames = useRef(false);
  useEffect(() => {
    if (!open || didLoadNames.current) return;
    if (visibleShares.length === 0) return;
    didLoadNames.current = true;
    void (async () => {
      const resolved = await resolveNames(visibleShares);
      setPrincipalMeta(resolved);
    })();
  }, [open, visibleShares]);

  // Close on outside click or Escape. The portal'd popover isn't a DOM
  // descendant of the button, so the click check must include both.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current && popoverRef.current.contains(target)
      ) return;
      if (buttonRef.current && buttonRef.current.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Recompute the portal's anchor position whenever the button moves
  // (open toggles, window resizes, page scrolls). Uses right-edge
  // anchoring so the popover stays aligned with the chip even when
  // the chip is in a compact toolbar.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setPopoverPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const setAccess = useCallback(
    async (next: ItemAccess) => {
      if (next === currentAccess) return;
      setError(null);
      const prev = currentAccess;
      setCurrentAccess(next); // optimistic
      setSaving('access');
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access: next }),
      });
      setSaving(null);
      if (!res.ok) {
        setCurrentAccess(prev);
        setError(t('sharing.updateFailed', { status: res.status }));
        return;
      }
      // #310: prompt for cascade only when transitioning UP to
      // public. Going to private/org doesn't expose anything
      // newly, so no cascade is warranted. Only triggers from a
      // non-public starting tier so picking 'public' twice in a
      // row doesn't re-prompt unnecessarily.
      if (next === 'public' && prev !== 'public') {
        // #84: snapshot the prior tier so the cascade dialog's
        // Cancel button can revert if the author changes their
        // mind after seeing the dep list.
        setPreCascadeAccess(prev);
        setCascadeOpen(true);
      }
      // #334: inverse cascade. Transitioning OUT of public is the
      // moment to offer to revert dependencies that were only
      // public because of this parent. The dialog self-dismisses
      // when the candidate list is empty, so a flip with no
      // independent-public deps stays silent. We seed the
      // downgrade target tier from where the parent landed (org
      // or private) so the dialog's default keeps the cascade
      // visually consistent with what the author just chose.
      if (prev === 'public' && next !== 'public') {
        setRevertTarget(next);
        setRevertOpen(true);
      }
      router.refresh();
    },
    [currentAccess, itemId, router, t],
  );

  const removeShare = useCallback(
    async (share: ItemShare) => {
      setError(null);
      const key = `${share.principalType}:${share.principalId}`;
      setSaving(key);
      const res = await fetch(`/api/portal/items/${itemId}/share`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalType: share.principalType,
          principalId: share.principalId,
        }),
      });
      setSaving(null);
      if (!res.ok) {
        setError(t('sharing.removeFailed', { status: res.status }));
        return;
      }
      setCurrentShares((prev) =>
        prev.filter(
          (s) =>
            !(
              s.principalType === share.principalType &&
              s.principalId === share.principalId
            ),
        ),
      );
      router.refresh();
    },
    [itemId, router, t],
  );

  const popover =
    open && popoverPos && typeof document !== 'undefined' ? (
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={t('sharing.dialogLabel', { title: itemTitle })}
        onClick={(e) => {
          if (stopParentLink) e.stopPropagation();
        }}
        // Fixed-positioned so no ancestor overflow-hidden or stacking
        // context clips or hides it. z-50 keeps it above the app shell's
        // sticky top-bar (z-10).
        style={{ top: popoverPos.top, right: popoverPos.right }}
        className="fixed z-50 w-72 overflow-hidden rounded-lg border border-border bg-surface-1 text-left shadow-raised"
      >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-xs font-semibold text-ink-0" title={itemTitle}>
              {itemTitle}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-muted">
              {t('sharing.sharing')}
            </p>
          </div>

          <div className="space-y-1 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
              {t('sharing.whoCanSee')}
            </p>
            <div className="grid grid-cols-3 gap-1" role="radiogroup">
              {(['private', 'org', 'public'] as const).map((lvl) => {
                const info = ACCESS_META[lvl];
                const lvlLabel = accessLabel(t, lvl);
                const selected = currentAccess === lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!canManage || saving === 'access'}
                    onClick={() => void setAccess(lvl)}
                    className={`inline-flex flex-col items-center gap-0.5 rounded-md border px-1.5 py-1 text-[10px] ${
                      selected
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                    } disabled:opacity-50`}
                    title={lvlLabel}
                  >
                    <info.Icon className="h-3.5 w-3.5" />
                    <span>{lvlLabel}</span>
                  </button>
                );
              })}
            </div>
            {saving === 'access' ? (
              <p className="flex items-center gap-1 text-[10px] text-muted">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('sharing.saving')}
              </p>
            ) : null}
          </div>

          <div className="border-t border-border px-3 py-2">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              {t('sharing.explicitShares')}{' '}
              <span className="text-muted">({shareCount})</span>
            </p>
            {visibleShares.length === 0 ? (
              <p className="text-[11px] text-muted">
                {t('sharing.noExplicitShares')}
              </p>
            ) : (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {visibleShares.map((s) => (
                  <SharingRow
                    key={`${s.principalType}:${s.principalId}`}
                    share={s}
                    meta={
                      s.principalType === 'user'
                        ? principalMeta.users[s.principalId]
                        : principalMeta.groups[s.principalId]
                    }
                    canManage={canManage}
                    isSelf={
                      s.principalType === 'user' &&
                      s.principalId === currentUserId
                    }
                    saving={saving === `${s.principalType}:${s.principalId}`}
                    onRemove={() => void removeShare(s)}
                  />
                ))}
              </ul>
            )}
          </div>

          {error ? (
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="border-t border-border bg-surface-2 px-3 py-1.5">
            <a
              href={`/items/${itemId}#sharing`}
              onClick={(e) => {
                if (stopParentLink) e.stopPropagation();
              }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              {t('sharing.manageSharing')} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
    ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          if (stopParentLink) {
            e.preventDefault();
            e.stopPropagation();
          }
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.chipBg} ${meta.chipText} ring-1 ring-inset ring-transparent hover:ring-current/20`}
        title={
          shareCount > 0
            ? t('sharing.chipTitleShared', {
                label: accessLabel(t, currentAccess),
                count: shareCount,
              })
            : accessLabel(t, currentAccess)
        }
      >
        <meta.Icon className="h-3 w-3" />
        <span>{accessLabel(t, currentAccess)}</span>
        {shareCount > 0 ? (
          <span className="ml-0.5 rounded-full bg-white/50 px-1 text-[10px] leading-4 text-current">
            +{shareCount}
          </span>
        ) : null}
      </button>
      {popover && typeof document !== 'undefined'
        ? createPortal(popover, document.body)
        : null}
      {/* #310 cascade prompt. Mounted unconditionally so the
          dialog can drive its own open/close state -- the dialog
          self-dismisses when the dependency walk returns an
          empty list, so a no-op flip to public stays silent. */}
      <PublicCascadeDialog
        open={cascadeOpen}
        parentId={itemId}
        parentTitle={itemTitle}
        onClose={() => {
          setCascadeOpen(false);
          router.refresh();
        }}
        onCancel={() => {
          // #84: revert the parent flip back to its pre-public
          // tier. Reuse setAccess so the optimistic-flip-and-
          // revert handling is identical to a manual change.
          setCascadeOpen(false);
          void setAccess(preCascadeAccess);
        }}
      />
      {/* #334 cascade-revert prompt. Same self-dismissing pattern
          as the public cascade above; fires when the access
          transition was OUT of public. */}
      <PublicCascadeRevertDialog
        open={revertOpen}
        parentId={itemId}
        parentTitle={itemTitle}
        downgradeTo={revertTarget}
        onClose={() => {
          setRevertOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

interface SharingRowProps {
  share: ItemShare;
  meta: PrincipalMeta | undefined;
  canManage: boolean;
  /** True when the share's principal is the current viewer. The row
   *  renders a "(you)" tag and suppresses the remove button so users
   *  cannot accidentally yank their own access; admins/owners can
   *  still remove via the full Manage sharing page. */
  isSelf: boolean;
  saving: boolean;
  onRemove: () => void;
}

function SharingRow({
  share,
  meta,
  canManage,
  isSelf,
  saving,
  onRemove,
}: SharingRowProps) {
  const t = useT();
  const Icon = share.principalType === 'group' ? UsersIcon : UserRound;
  const baseLabel =
    meta?.label ?? `${share.principalType} ${share.principalId.slice(0, 8)}`;
  const label = isSelf ? t('sharing.youSuffix', { label: baseLabel }) : baseLabel;
  const sublabel = meta?.sublabel;
  const perm: SharePermission = share.permission;

  return (
    <li className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-surface-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ink-1" title={label}>
          {label}
        </p>
        {sublabel ? (
          <p className="truncate text-[10px] text-muted">{sublabel}</p>
        ) : null}
      </div>
      <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted">
        {t(`sharing.permission.${perm}`)}
      </span>
      {canManage && !isSelf ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={saving}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-1 hover:text-danger disabled:opacity-50"
          aria-label={t('sharing.removePrincipal', { label })}
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </li>
  );
}
