// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Surfaces layer.syncConflicts artifacts (#329 follow-up / R2).
 *
 * Optimistic-concurrency 409s already stamp a capped ring buffer on
 * the layer JSON. Until this panel, nothing in portal-web read it,
 * so field crews lost the "reopen the losing edit" path that Mergin-
 * shaped recoverability needs. Read-only list; clearing conflicts is
 * a follow-up.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { SyncConflictArtifact } from '@gratis-gis/shared-types';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import { summarizeSyncConflictLosingSide } from '@/lib/sync-conflicts-summary';

interface Props {
  conflicts: SyncConflictArtifact[];
}

export function SyncConflictsPanel({ conflicts }: Props) {
  const t = useT();
  const fmt = useFormat();
  const [open, setOpen] = useState(true);

  if (!conflicts.length) return null;

  // Newest first: the ring buffer appends, so reverse for display.
  const ordered = [...conflicts].reverse();

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
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
