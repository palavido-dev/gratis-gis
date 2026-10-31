// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Past runs shelf on the Analyze workbench (analyze-run-history).
 *
 * Lists this user's derived_layer items sourced from the open
 * data_layer, with Re-run (POST a private duplicate) and Edit &
 * re-run (Analyze ?tool= deep link when a guide exists).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { History, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  analyzeToolDeepLink,
  type AnalyzeToolId,
} from '@/lib/analyze-tool-ids';
import {
  buildRerunDerivedLayerCreatePayload,
  labelForPipelineTool,
  pastRunsListUrl,
  pipelineToolToAnalyzeId,
  selectPastRunsForSource,
  type AnalyzePastRun,
  type DerivedLayerListItem,
} from '@/lib/analyze-run-history';

interface Props {
  itemId: string;
  /** v3 sublayer id; filters recipes stamped with layerKey. */
  layerKey: string;
  /**
   * Prefer expanding the matching guide in-panel (avoids fighting
   * the one-shot deep-link consume on the parent Data tab).
   */
  onEditTool?: (tool: AnalyzeToolId) => void;
}

export function AnalyzePastRuns({ itemId, layerKey, onEditTool }: Props) {
  const t = useT();
  const fmt = useFormat();
  const router = useRouter();
  const [phase, setPhase] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; runs: AnalyzePastRun[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [rerunningId, setRerunningId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase({ kind: 'loading' });
    try {
      const res = await fetch(pastRunsListUrl(50), {
        signal: signal ?? null,
      });
      if (!res.ok) {
        throw new Error(
          t('analyzeWorkbench.pastRunsLoadFailed', { status: res.status }),
        );
      }
      const rows = (await res.json()) as DerivedLayerListItem[];
      if (signal?.aborted) return;
      const runs = selectPastRunsForSource(
        Array.isArray(rows) ? rows : [],
        itemId,
        layerKey,
      );
      setPhase({ kind: 'ready', runs });
    } catch (err) {
      if (signal?.aborted) return;
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [itemId, layerKey, t]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  async function rerun(run: AnalyzePastRun): Promise<void> {
    if (rerunningId) return;
    setRerunningId(run.id);
    try {
      const payload = buildRerunDerivedLayerCreatePayload({
        title: t('analyzeWorkbench.pastRunsRerunTitle', { title: run.title }),
        description: t('analyzeWorkbench.pastRunsRerunDescription', {
          title: run.title,
        }),
        data: run.data,
      });
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          t('analyzeWorkbench.pastRunsRerunFailed', {
            status: res.status,
            detail: await res.text().catch(() => ''),
          }),
        );
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new Error(t('analyzeWorkbench.bufferMissingId'));
      }
      toast.success(
        t('analyzeWorkbench.pastRunsRerunToast', { title: payload.title }),
      );
      router.push(`/items/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunningId(null);
    }
  }

  function editAndRerun(run: AnalyzePastRun): void {
    const tool = pipelineToolToAnalyzeId(run.firstTool);
    if (!tool) return;
    if (onEditTool) {
      onEditTool(tool);
      return;
    }
    router.push(analyzeToolDeepLink(itemId, tool, layerKey));
  }

  return (
    <section
      className="space-y-1.5 border-t border-border/70 pt-2"
      aria-label={t('analyzeWorkbench.pastRunsHeading')}
    >
      <header className="flex flex-wrap items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-muted" aria-hidden />
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted">
          {t('analyzeWorkbench.pastRunsHeading')}
        </h3>
        <span className="text-2xs text-muted">
          {t('analyzeWorkbench.pastRunsHint')}
        </span>
        {phase.kind === 'ready' && phase.runs.length > 0 ? (
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto text-2xs text-ink-1 underline-offset-2 hover:underline"
          >
            {t('analyzeWorkbench.pastRunsRefresh')}
          </button>
        ) : null}
      </header>

      {phase.kind === 'loading' ? (
        <div className="flex items-center gap-1.5 text-2xs text-muted">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {t('analyzeWorkbench.pastRunsLoading')}
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-danger">
          <span>{phase.message}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-ink-1 underline-offset-2 hover:underline"
          >
            {t('analyzeWorkbench.pastRunsRetry')}
          </button>
        </div>
      ) : null}

      {phase.kind === 'ready' && phase.runs.length === 0 ? (
        <p className="text-2xs text-muted">
          {t('analyzeWorkbench.pastRunsEmpty')}
        </p>
      ) : null}

      {phase.kind === 'ready' && phase.runs.length > 0 ? (
        <ul className="divide-y divide-border/60 border border-border bg-surface-1">
          {phase.runs.map((run) => {
            const editTool = pipelineToolToAnalyzeId(run.firstTool);
            const busy = rerunningId === run.id;
            return (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-2xs"
              >
                <Link
                  href={`/items/${run.id}`}
                  className="min-w-0 flex-1 truncate font-medium text-ink-0 underline-offset-2 hover:underline"
                  title={run.title}
                >
                  {run.title}
                </Link>
                <span className="shrink-0 text-muted">
                  {run.createdAt
                    ? fmt.relativeTime(run.createdAt)
                    : t('analyzeWorkbench.pastRunsUnknownDate')}
                </span>
                <span className="shrink-0 rounded border border-border bg-surface-0 px-1.5 py-0.5 text-ink-1">
                  {labelForPipelineTool(String(run.firstTool))}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void rerun(run)}
                    disabled={busy || rerunningId !== null}
                    title={t('analyzeWorkbench.pastRunsRerunTitleAttr')}
                    className="rounded border border-border bg-surface-0 px-1.5 py-0.5 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      t('analyzeWorkbench.pastRunsRerun')
                    )}
                  </button>
                  {editTool ? (
                    <button
                      type="button"
                      onClick={() => editAndRerun(run)}
                      disabled={rerunningId !== null}
                      title={t('analyzeWorkbench.pastRunsEditTitleAttr')}
                      className="rounded border border-border bg-surface-0 px-1.5 py-0.5 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      {t('analyzeWorkbench.pastRunsEdit')}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
