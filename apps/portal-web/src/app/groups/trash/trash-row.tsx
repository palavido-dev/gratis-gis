// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Group } from '@gratis-gis/shared-types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useFormat } from '@/lib/i18n/format';

interface Props {
  group: Group;
  retentionDays: number;
}

export function TrashRow({ group, retentionDays }: Props) {
  const fmt = useFormat();
  const router = useRouter();
  const [pending, setPending] = useState<'restore' | 'purge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const deletedAt = group.deletedAt ? new Date(group.deletedAt) : null;
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
      const res = await fetch(`/api/portal/groups/${group.id}/restore`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError(`Restore failed: ${res.status} ${await res.text()}`);
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
      const res = await fetch(`/api/portal/groups/${group.id}/purge`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(`Purge failed: ${res.status} ${await res.text()}`);
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
        <div className="font-medium text-ink-0">{group.title}</div>
        {group.description ? (
          <div className="mt-0.5 truncate text-xs text-muted">{group.description}</div>
        ) : null}
      </td>
      <td className="py-3 pr-4 text-xs text-muted">
        {deletedAt ? fmt.dateTime(deletedAt) : ''}
      </td>
      <td className="py-3 pr-4 text-xs text-muted">
        {daysLeft !== null ? (
          <span>
            {daysLeft} day{daysLeft === 1 ? '' : 's'} left
          </span>
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
            {pending === 'restore' ? 'Restoring' : 'Restore'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmPurge(true)}
            disabled={pending !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-danger shadow-card hover:bg-danger/5 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete forever
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
          title={`Permanently delete "${group.title}"?`}
          description="This immediately removes the group, its memberships, and every share that targeted it. This cannot be undone."
          requireTypedConfirmation={group.title}
          confirmLabel="Delete forever"
        />
      </td>
    </tr>
  );
}
