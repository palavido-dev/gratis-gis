// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Group-by action on the Analyze workbench
 * (R11-analyze-group-by-shortcut).
 *
 * Same honesty stance as Top N / Contour: Analyze does not fake
 * an in-browser rollup. It opens a one-key / one-agg form and
 * POSTs a single-step `aggregate` derived_layer recipe. Geometry
 * is always ST_Union per group; multi-key / multi-agg stay in the
 * derived-layer builder.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, TableProperties } from 'lucide-react';
import type { FeatureField } from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  GROUP_BY_SHORTCUT_OPS,
  buildGroupByDerivedLayerCreatePayload,
  defaultGroupByDerivedLayerTitle,
  defaultGroupByOutputName,
  groupableFields,
  numericFieldsForGroupBy,
  validateGroupByParams,
  type GroupByShortcutOp,
} from '@/lib/analyze-group-by-derived';

interface Props {
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  layerKey: string;
  sourceLabel: string;
  fields: FeatureField[];
}

export function AnalyzeGroupByGuide({
  itemId,
  layerKey,
  sourceLabel,
  fields,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const t = useT();
  const keys = useMemo(() => groupableFields(fields), [fields]);
  const numericFields = useMemo(() => numericFieldsForGroupBy(fields), [fields]);
  const [open, setOpen] = useState(defaultOpen);
  const [groupKey, setGroupKey] = useState(keys[0]?.name ?? '');
  const [op, setOp] = useState<GroupByShortcutOp>('count');
  const [aggField, setAggField] = useState(numericFields[0]?.name ?? '');
  const [outputName, setOutputName] = useState('count');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [outputTouched, setOutputTouched] = useState(false);

  useEffect(() => {
    if (!outputTouched) {
      setOutputName(defaultGroupByOutputName(op, aggField));
    }
  }, [op, aggField, outputTouched]);

  const suggestedTitle = useMemo(
    () =>
      defaultGroupByDerivedLayerTitle(sourceLabel, groupKey, op, aggField),
    [sourceLabel, groupKey, op, aggField],
  );

  const reason = validateGroupByParams(
    groupKey,
    op,
    aggField,
    outputName,
    fields,
  );
  const validationError =
    reason && /not a field/.test(reason)
      ? t('analyzeWorkbench.groupByValidateKey')
      : reason && /count, sum, or avg/.test(reason)
        ? t('analyzeWorkbench.groupByValidateOp')
        : reason && /numeric field for sum/.test(reason)
          ? t('analyzeWorkbench.groupByValidateAggField')
          : reason && /not a numeric/.test(reason)
            ? t('analyzeWorkbench.groupByValidateAggField')
            : reason && /collide/.test(reason)
              ? t('analyzeWorkbench.groupByValidateOutputCollision')
              : reason && /Output name/.test(reason)
                ? t('analyzeWorkbench.groupByValidateOutput')
                : reason
                  ? t('analyzeWorkbench.groupByValidateKey')
                  : null;

  async function createGroupByLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildGroupByDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        groupKey,
        op,
        aggField,
        outputName: outputName.trim() || defaultGroupByOutputName(op, aggField),
      });
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          t('analyzeWorkbench.bufferCreateFailed', {
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
        t('analyzeWorkbench.bufferCreatedToast', { title: payload.title }),
      );
      router.push(`/items/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!groupKey && keys[0]) setGroupKey(keys[0].name);
          if (!aggField && numericFields[0]) setAggField(numericFields[0].name);
          setTitle(suggestedTitle);
        }}
        title={t('analyzeWorkbench.groupByActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <TableProperties className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.groupByAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.groupByHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.groupByIntroBefore')}{' '}
            <a
              href="/help/analysis/group-by"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.groupByHelpLink')}
            </a>
            {t('analyzeWorkbench.groupByIntroTail')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {t('analyzeWorkbench.cancel')}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[10rem] flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.groupByKey')}</span>
          <select
            value={groupKey}
            onChange={(e) => setGroupKey(e.target.value)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.groupByKeyAria')}
          >
            <option value="">{t('analyzeWorkbench.groupByWholeLayer')}</option>
            {keys.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label || f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.groupByOp')}</span>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value as GroupByShortcutOp)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.groupByOpAria')}
          >
            {GROUP_BY_SHORTCUT_OPS.map((o) => (
              <option key={o} value={o}>
                {t(`analyzeWorkbench.groupByOp_${o}`)}
              </option>
            ))}
          </select>
        </label>
        {op !== 'count' ? (
          <label className="flex min-w-[10rem] flex-col gap-0.5 text-2xs text-ink-1">
            <span>{t('analyzeWorkbench.groupByAggField')}</span>
            <select
              value={aggField}
              onChange={(e) => setAggField(e.target.value)}
              disabled={busy || numericFields.length === 0}
              className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
              aria-label={t('analyzeWorkbench.groupByAggFieldAria')}
            >
              {aggField === '' ? (
                <option value="">
                  {numericFields.length === 0
                    ? t('analyzeWorkbench.groupByNoNumeric')
                    : t('analyzeWorkbench.groupByPickNumeric')}
                </option>
              ) : null}
              {numericFields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label || f.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.groupByOutput')}</span>
          <input
            type="text"
            value={outputName}
            onChange={(e) => {
              setOutputTouched(true);
              setOutputName(e.target.value);
            }}
            disabled={busy}
            className="h-7 w-28 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.groupByOutputAria')}
          />
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.derivedTitle')}</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={suggestedTitle}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.derivedTitleAria')}
          />
        </label>
        <button
          type="button"
          onClick={() => void createGroupByLayer()}
          disabled={busy || Boolean(validationError)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {busy
            ? t('analyzeWorkbench.creatingEllipsis')
            : t('analyzeWorkbench.createDerivedLayer')}
        </button>
      </div>

      {validationError ? (
        <p className="text-2xs text-danger" role="alert">
          {validationError}
        </p>
      ) : (
        <p className="text-2xs text-muted">{t('analyzeWorkbench.groupByHint')}</p>
      )}
    </div>
  );
}
