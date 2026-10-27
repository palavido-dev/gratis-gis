// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Surfaces layer.syncConflicts artifacts (#329 / #339) and lets editors
 * re-apply the losing side (R3-sync-conflict-reapply) or dismiss a
 * reviewed card (R6-sync-conflict-dismiss).
 *
 * Optimistic-concurrency 409s stamp a capped ring buffer on the layer
 * JSON. Re-apply PATCHes / DELETEs with the live baseObservationId, or
 * POSTs a recreate when the feature is gone. Dismiss drops one
 * artifact by id after confirm (and after a successful re-apply when
 * the editor accepts).
 */
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  X,
} from 'lucide-react';
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';
import { useConfirm } from '@/components/dialog-provider';
import { parseApiError } from '@/lib/api-error';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  planSyncConflictReapply,
  type SyncConflictLiveHead,
} from '@/lib/sync-conflicts-reapply';
import { summarizeSyncConflictLosingSide } from '@/lib/sync-conflicts-summary';

interface Props {
  conflicts: SyncConflictArtifact[];
  itemId: string;
  layerId: string;
  canEdit: boolean;
}

export function SyncConflictsPanel({
  conflicts,
  itemId,
  layerId,
  canEdit,
}: Props) {
  const t = useT();
  const fmt = useFormat();
  const router = useRouter();
  const confirm = useConfirm();
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!conflicts.length) return null;

  // Newest first: the ring buffer appends, so reverse for display.
  const ordered = [...conflicts].reverse();

  async function probeLiveHead(
    featureId: string,
  ): Promise<SyncConflictLiveHead> {
    const res = await fetch(
      `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerId)}/features?entity=${encodeURIComponent(featureId)}`,
    );
    if (!res.ok) {
      throw new Error(
        await parseApiError(res, t('layerDataPanel.syncConflictReapplyFailed')),
      );
    }
    const fc = (await res.json()) as {
      features?: Array<{ properties?: Record<string, unknown> | null }>;
    };
    const f = fc.features?.[0];
    if (!f) return { exists: false };
    const obs = f.properties?._observation_id;
    return {
      exists: true,
      ...(typeof obs === 'string' ? { observationId: obs } : {}),
    };
  }

  async function executePlan(
    plan: ReturnType<typeof planSyncConflictReapply>,
  ): Promise<void> {
    const base = `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerId)}/features`;
    if (plan.method === 'noop') return;
    if (plan.method === 'unavailable') {
      throw new Error(t('layerDataPanel.syncConflictReapplyUnavailable'));
    }
    if (plan.method === 'PATCH') {
      const res = await fetch(
        `${base}/${encodeURIComponent(plan.featureId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(plan.body),
        },
      );
      if (!res.ok) {
        throw new Error(
          await parseApiError(
            res,
            t('layerDataPanel.syncConflictReapplyFailed'),
          ),
        );
      }
      return;
    }
    if (plan.method === 'DELETE') {
      const res = await fetch(
        `${base}/${encodeURIComponent(plan.featureId)}`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(plan.body),
        },
      );
      if (!res.ok && res.status !== 204) {
        throw new Error(
          await parseApiError(
            res,
            t('layerDataPanel.syncConflictReapplyFailed'),
          ),
        );
      }
      return;
    }
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plan.body),
    });
    if (!res.ok) {
      throw new Error(
        await parseApiError(res, t('layerDataPanel.syncConflictReapplyFailed')),
      );
    }
  }

  function sideSummary(
    side: SyncConflictArtifact['losingSide'] | SyncConflictArtifact['current'],
    asDelete: boolean,
  ): string {
    if (asDelete || !side) {
      return t('layerDataPanel.syncConflictSideDeleted');
    }
    return summarizeSyncConflictLosingSide(
      {
        id: 'x',
        at: '1970-01-01T00:00:00.000Z' as SyncConflictArtifact['at'],
        featureId: String(side.id),
        op: 'update',
        losingSide: side,
        current: null,
      },
      {
        losingDelete: t('layerDataPanel.syncConflictSideDeleted'),
        losingEmpty: t('layerDataPanel.syncConflictSideEmpty'),
        losingSummary: (sample) =>
          t('layerDataPanel.syncConflictSideSummary', { sample }),
        losingMore: (count) =>
          t('layerDataPanel.syncConflictLosingMore', { count }),
      },
    );
  }

  function confirmBody(c: SyncConflictArtifact): ReactNode {
    const losing =
      c.op === 'delete'
        ? t('layerDataPanel.syncConflictLosingDelete')
        : sideSummary(c.losingSide, false);
    const current = sideSummary(c.current, c.current === null);
    return (
      <div className="mt-2 space-y-2 rounded border border-border bg-surface-0 p-2 text-2xs text-ink-1">
        <div>
          <p className="font-medium text-ink-0">
            {t('layerDataPanel.syncConflictCompareLosing')}
          </p>
          <p className="mt-0.5 text-muted">{losing}</p>
        </div>
        <div>
          <p className="font-medium text-ink-0">
            {t('layerDataPanel.syncConflictCompareCurrent')}
          </p>
          <p className="mt-0.5 text-muted">{current}</p>
        </div>
      </div>
    );
  }

  async function reapply(c: SyncConflictArtifact) {
    if (!canEdit || busyId) return;
    setError(null);

    let live: SyncConflictLiveHead;
    try {
      live = await probeLiveHead(c.featureId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('layerDataPanel.syncConflictReapplyFailed'),
      );
      return;
    }

    const plan = planSyncConflictReapply(c, live);
    if (plan.method === 'unavailable') {
      setError(t('layerDataPanel.syncConflictReapplyUnavailable'));
      return;
    }

    const confirmLabel =
      plan.method === 'POST'
        ? t('layerDataPanel.syncConflictRecreateAction')
        : plan.method === 'DELETE'
          ? t('layerDataPanel.syncConflictReapplyDeleteAction')
          : plan.method === 'noop'
            ? t('layerDataPanel.syncConflictReapplyAction')
            : t('layerDataPanel.syncConflictReapplyAction');

    const message =
      plan.method === 'POST'
        ? t('layerDataPanel.syncConflictRecreateMessage')
        : plan.method === 'DELETE'
          ? t('layerDataPanel.syncConflictReapplyDeleteMessage')
          : plan.method === 'noop'
            ? t('layerDataPanel.syncConflictAlreadyDeletedMessage')
            : t('layerDataPanel.syncConflictReapplyMessage');

    const ok = await confirm({
      title: t('layerDataPanel.syncConflictReapplyTitle'),
      message,
      body: confirmBody(c),
      confirmLabel,
      variant: plan.method === 'DELETE' ? 'danger' : 'default',
    });
    if (!ok) return;

    if (plan.method === 'noop') {
      const clear = await confirm({
        title: t('layerDataPanel.syncConflictDismissTitle'),
        message: t('layerDataPanel.syncConflictDismissAfterNoop'),
        confirmLabel: t('layerDataPanel.syncConflictDismissAction'),
      });
      if (clear) {
        await dismiss(c.id);
      } else {
        router.refresh();
      }
      return;
    }

    setBusyId(c.id);
    try {
      await executePlan(plan);
      setBusyId(null);
      const clear = await confirm({
        title: t('layerDataPanel.syncConflictDismissTitle'),
        message: t('layerDataPanel.syncConflictDismissAfterReapply'),
        confirmLabel: t('layerDataPanel.syncConflictDismissAction'),
      });
      if (clear) {
        await dismiss(c.id);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('layerDataPanel.syncConflictReapplyFailed'),
      );
      setBusyId(null);
    }
  }

  async function dismiss(conflictId: string) {
    if (!canEdit) return;
    setError(null);
    setBusyId(conflictId);
    try {
      const res = await fetch(
        `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerId)}/sync-conflicts/${encodeURIComponent(conflictId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error(
          await parseApiError(
            res,
            t('layerDataPanel.syncConflictDismissFailed'),
          ),
        );
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('layerDataPanel.syncConflictDismissFailed'),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDismiss(c: SyncConflictArtifact) {
    if (!canEdit || busyId) return;
    const ok = await confirm({
      title: t('layerDataPanel.syncConflictDismissTitle'),
      message: t('layerDataPanel.syncConflictDismissMessage'),
      confirmLabel: t('layerDataPanel.syncConflictDismissAction'),
      variant: 'danger',
    });
    if (!ok) return;
    await dismiss(c.id);
  }

  return (
    <div className="mt-2 rounded-md border border-warn/40 bg-warn/5">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-ink-0"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="flex-1">
          {t('layerDataPanel.syncConflictsTitle', {
            count: conflicts.length,
          })}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted" />
        )}
      </button>
      {open ? (
        <div className="border-t border-warn/30 px-2.5 py-2">
          <p className="mb-2 text-2xs text-muted">
            {t('layerDataPanel.syncConflictsIntro')}
          </p>
          {error ? (
            <p role="alert" className="mb-2 text-2xs text-danger">
              {error}
            </p>
          ) : null}
          <ul className="max-h-48 space-y-1.5 overflow-y-auto">
            {ordered.map((c) => (
              <li
                key={c.id}
                className="rounded border border-border bg-surface-1 px-2 py-1.5 text-2xs text-ink-1"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium text-ink-0">
                    {c.op === 'delete'
                      ? t('layerDataPanel.syncConflictOpDelete')
                      : t('layerDataPanel.syncConflictOpUpdate')}
                  </span>
                  <span className="font-mono text-muted">{c.featureId}</span>
                  <span className="text-muted">
                    {fmt.dateTime(c.at)}
                  </span>
                </div>
                <p className="mt-0.5 text-muted">
                  {summarizeSyncConflictLosingSide(c, {
                    losingDelete: t(
                      'layerDataPanel.syncConflictLosingDelete',
                    ),
                    losingEmpty: t(
                      'layerDataPanel.syncConflictLosingEmpty',
                    ),
                    losingSummary: (sample) =>
                      t('layerDataPanel.syncConflictLosingSummary', {
                        sample,
                      }),
                    losingMore: (count) =>
                      t('layerDataPanel.syncConflictLosingMore', {
                        count,
                      }),
                  })}
                </p>
                {canEdit ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void reapply(c)}
                      className="inline-flex items-center gap-1 rounded border border-border bg-surface-0 px-1.5 py-0.5 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-60"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {busyId === c.id
                        ? t('layerDataPanel.syncConflictReapplyBusy')
                        : t('layerDataPanel.syncConflictReapplyAction')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void confirmDismiss(c)}
                      className="inline-flex items-center gap-1 rounded border border-border bg-surface-0 px-1.5 py-0.5 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-60"
                    >
                      <X className="h-3 w-3" />
                      {busyId === c.id
                        ? t('layerDataPanel.syncConflictDismissBusy')
                        : t('layerDataPanel.syncConflictDismissAction')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
