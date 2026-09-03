// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The parked half of the offline queue. A queued edit the server
 * refused for a reason a retry cannot change (the schema validator
 * said no, sharing said no, a conflict) lands here as 'rejected'
 * instead of being retried on every sync forever. This is the only
 * place those rows surface: each shows what it was, when, and the
 * server's sentence, with two ways out. Retry puts it back in line
 * (right after the worker fixes whatever the reason names, or when
 * an admin has widened access); Discard drops it.
 *
 * Discard is destructive in the plain sense: the edit exists nowhere
 * else. It goes through useConfirm so a thumb on a phone cannot lose
 * a day's capture by accident.
 */

import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirm } from '@/components/dialog-provider';
import { useT } from '@/lib/i18n/locale-context';
import type { QueueRecord } from '@/lib/offline-store';
import { discardRejected, retryRejected } from '@/lib/offline-sync';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: QueueRecord[];
  /** Plain-English label for a queued row's layer, or null when the
   *  layer is no longer in the deployment. */
  layerLabelFor: (record: QueueRecord) => string | null;
  /** Called after any row changes state so the caller re-reads the
   *  queue and, for retries, kicks off a sync. */
  onChanged: (action: 'retried' | 'discarded') => void;
}

export function RejectedEditsDialog({
  open,
  onOpenChange,
  records,
  layerLabelFor,
  onChanged,
}: Props) {
  const t = useT();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);

  const retry = async (record: QueueRecord) => {
    setBusyId(record.id);
    try {
      await retryRejected(record);
      onChanged('retried');
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (record: QueueRecord) => {
    const ok = await confirm({
      title: t('fieldQueue.discardTitle'),
      message: t('fieldQueue.discardMessage'),
      confirmLabel: t('fieldQueue.discardAction'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(record.id);
    try {
      await discardRejected(record);
      onChanged('discarded');
    } finally {
      setBusyId(null);
    }
  };

  const retryAll = async () => {
    setBusyId('*');
    try {
      for (const record of records) await retryRejected(record);
      onChanged('retried');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('fieldQueue.rejectedTitle')}</DialogTitle>
          <DialogDescription>{t('fieldQueue.rejectedIntro')}</DialogDescription>
        </DialogHeader>
        {records.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            {t('fieldQueue.rejectedEmpty')}
          </p>
        ) : (
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
            {records.map((record) => {
              const busy = busyId === record.id || busyId === '*';
              const layer = layerLabelFor(record) ?? t('fieldQueue.unknownLayer');
              return (
                <li
                  key={record.id}
                  className="rounded-md border border-danger/30 bg-danger/5 p-3"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-ink-0">
                      {t(`fieldQueue.op.${record.op}`, { layer })}
                    </p>
                    <time
                      dateTime={record.queuedAt}
                      className="shrink-0 text-2xs text-muted"
                    >
                      {new Date(record.queuedAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-danger">
                    {record.failureReason ?? t('fieldQueue.noReason')}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void retry(record)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-60"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('fieldQueue.retry')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void discard(record)}
                      className="inline-flex items-center gap-1 rounded-md border border-danger/30 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
                    >
                      <Trash2 className="h-3 w-3" />
                      {t('fieldQueue.discard')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          {records.length > 1 ? (
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void retryAll()}
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-60"
            >
              {t('fieldQueue.retryAll', { count: records.length })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90"
          >
            {t('fieldQueue.close')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
