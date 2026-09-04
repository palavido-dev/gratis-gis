// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, X } from 'lucide-react';
import type { ItemShare, ItemType, SharePermission } from '@gratis-gis/shared-types';
import { getItemDisplayIcon, getItemDisplayLabel } from '@/lib/item-type-icon';
import { useConfirm } from '@/components/dialog-provider';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Items shared with a group, on the group detail page (#76).
 *
 * The group page used to show members only, so "what does this group
 * actually grant access to" was unanswerable from the page that
 * defines the group; you had to already know an item and read its
 * sharing panel. The server has answered this since #100
 * (`/items?sharedWithGroupId=`), and the list rows already carry
 * their share rows, so the permission badge costs no extra fetch.
 *
 * Rows link to the item detail page (not the runtime deep-link the
 * catalogue uses): from a group you're auditing access, and the
 * detail page's Share tab is where that trail continues.
 *
 * Removing an item from the group revokes the group's share row via
 * the same DELETE /items/:id/share the sharing panel uses. The
 * button only renders when the caller could do it there too (item
 * owner or org admin); a group admin who is neither manages the
 * roster, not other people's items.
 *
 * The list is server-fetched and scoped by visibleWhere, so a
 * member sees only the shared items they can themselves see. That
 * can be fewer than the group's full grant (e.g. a geo-limited
 * share); the count reflects the caller's view, which is honest.
 */

export interface SharedItemRow {
  id: string;
  ownerId: string;
  type: ItemType;
  title: string;
  shares?: ItemShare[];
  owner?: { username?: string; fullName?: string | null } | null;
}

export function SharedItemsPanel({
  groupId,
  initialItems,
  currentUserId,
  isOrgAdmin,
}: {
  groupId: string;
  initialItems: SharedItemRow[];
  currentUserId: string;
  isOrgAdmin: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const confirm = useConfirm();
  const [items, setItems] = useState(initialItems);
  const [busy, setBusy] = useState<string | null>(null);

  function groupPermission(item: SharedItemRow): SharePermission | null {
    const row = (item.shares ?? []).find(
      (s) => s.principalType === 'group' && s.principalId === groupId,
    );
    return row?.permission ?? null;
  }

  async function remove(item: SharedItemRow) {
    const ok = await confirm({
      title: t('groupItems.removeTitle'),
      message: t('groupItems.removeBody', { title: item.title }),
      confirmLabel: t('groupItems.removeConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      const res = await fetch(`/api/portal/items/${item.id}/share`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalType: 'group',
          principalId: groupId,
        }),
      });
      if (!res.ok) {
        toast.error(t('groupItems.removeFailed', { status: res.status }));
        return;
      }
      setItems((rows) => rows.filter((r) => r.id !== item.id));
      toast.success(t('groupItems.removed', { title: item.title }));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted">{t('groupItems.empty')}</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1 shadow-card">
      {items.map((item) => {
        const Icon = getItemDisplayIcon(item);
        const permission = groupPermission(item);
        const canRemove = isOrgAdmin || item.ownerId === currentUserId;
        const ownerLabel =
          item.owner?.fullName?.trim() || item.owner?.username || null;
        return (
          <li
            key={item.id}
            className="flex items-center gap-3 px-4 py-2.5"
          >
            <Icon className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <Link
                href={`/items/${item.id}`}
                className="block truncate text-sm font-medium text-ink-0 hover:text-accent"
              >
                {item.title}
              </Link>
              <p className="mt-0.5 text-2xs text-muted">
                {getItemDisplayLabel(item)}
                {ownerLabel ? <> &middot; {ownerLabel}</> : null}
              </p>
            </div>
            {permission ? (
              <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-2xs text-muted">
                {t(`sharing.permission.${permission}`)}
              </span>
            ) : null}
            <Link
              href={`/items/${item.id}`}
              title={t('groupItems.openItem')}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-surface-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink-1"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
            {canRemove ? (
              <button
                type="button"
                onClick={() => void remove(item)}
                disabled={busy === item.id}
                title={t('groupItems.removeAction')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-surface-1 text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
