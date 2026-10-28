// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Centroid action on the Analyze workbench
 * (R6-analyze-centroid-shortcut).
 *
 * Same honesty stance as Buffer / Clip / Erase: Analyze does not
 * fake an in-browser centroid. It opens a short title form and
 * POSTs a single-step `derived_layer` recipe that runs
 * `ST_Centroid` on PostGIS — the same path as Create → Derived
 * layer → Centroid.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Crosshair, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  buildCentroidDerivedLayerCreatePayload,
  defaultCentroidDerivedLayerTitle,
} from '@/lib/analyze-centroid-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeCentroidGuide({
  itemId,
  layerKey,
  sourceLabel,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => defaultCentroidDerivedLayerTitle(sourceLabel),
    [sourceLabel],
  );

  async function createCentroidLayer(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const payload = buildCentroidDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
      });
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          `Could not create the derived layer (${res.status}): ${await res
            .text()
            .catch(() => '')}`,
        );
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new Error(
          'The derived layer was created but the response had no id.',
        );
      }
      toast.success(`Derived layer "${payload.title}" created`);
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
          setTitle(suggestedTitle);
        }}
        title="Create a server-side derived layer of geometric centroids (PostGIS ST_Centroid)."
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Crosshair className="h-3 w-3" aria-hidden />
        Centroids for this layer
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            Centroids for this layer (server derived layer)
          </p>
          <p className="text-2xs text-muted">
            Creates a private derived layer that runs{' '}
            <span className="font-mono">ST_Centroid</span> on PostGIS
            for every feature. Geometric centroid only (not pole of
            inaccessibility). Same recipe as{' '}
            <a
              href="/help/analysis/centroid"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              Centroid help
            </a>
            . Expect a short server job, not an instant browser result.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-0.5 text-2xs text-ink-1">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={suggestedTitle}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label="Derived layer title"
          />
        </label>
        <button
          type="button"
          onClick={() => void createCentroidLayer()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {busy ? 'Creating…' : 'Create derived layer'}
        </button>
      </div>

      <p className="text-2xs text-muted">
        Geometric centroid only. Open the new item to map or refresh the
        result after the server job finishes.
      </p>
    </div>
  );
}
