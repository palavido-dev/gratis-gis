// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Item } from '@gratis-gis/shared-types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getItemTypeLabel } from '@/lib/item-type-icon';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  item: Item;
  /** Retention window in days, used in the confirm-purge copy. */
  retentionDays: number;
}

/**
 * One row in the trash table. Handles both actions (restore + purge)
 * plus their loading/error state. Lives in the client because it
 * triggers fetches and needs router.refresh() afterward.
 */
export function TrashRow({ item, retentionDays }: Props) {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<'restore' | 'purge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const deletedAt = item.deletedAt ? new Date(item.deletedAt) : null;
  const purgeAt =
    deletedAt !== null
      ? new Date(deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000)
      : null;
  const daysLeft =
    purgeAt !== null
      ? Math.max(
          0,
          Math.ceil((purgeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        )
      : null;

  async function doRestore() {
    setError(null);
    setPending('restore');
    try {
      const res = await fetch(`/api/portal/items/${item.id}/restore`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError(t('trash.restoreFailed', { status: res.status, detail: await res.text() }));
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function doPurge() {
    setError(null);
    setPending('purge');
    try {
      const res = await fetch(`/api/portal/items/${item.id}/purge`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(t('trash.purgeFailed', { status: res.status, detail: await res.text() }));
        return;
      }
      setConfirmPurge(false);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-3 pr-4">
        <div className="font-medium text-ink-0">{item.title}</div>
        <div className="mt-0.5 text-xs text-muted">
          {getItemTypeLabel(item.type)}
        </div>
      </td>
      <td className="py-3 pr-4 text-xs text-muted">
        {deletedAt ? deletedAt.toLocaleString() : ''}
      </td>
      <td className="py-3 pr-4 text-xs text-muted">
        {daysLeft !== null ? (
          <span>{t('trash.daysLeft', { count: daysLeft })}</span>
        ) : null}
      </td>
      <td className="py-3 text-right">
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={doRestore}
            disabled={pending !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {pending === 'restore' ? t('trash.restoring') : t('trash.restore')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmPurge(true)}
            disabled={pending !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-danger shadow-card hover:bg-danger/5 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('trash.deleteForever')}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <ConfirmDialog
          open={confirmPurge}
          onCancel={() => setConfirmPurge(false)}
          onConfirm={doPurge}
          title={t('trash.purgeConfirmTitle', { title: item.title })}
          description={t('trash.purgeConfirmDescription')}
          requireTypedConfirmation={item.title}
          confirmLabel={t('trash.deleteForever')}
        />
      </td>
    </tr>
  );
}
