'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, FlaskConical, Layers } from 'lucide-react';
import {
  AREA_UNIT_LABELS,
  UNIT_LABELS,
  type DerivedLayerData,
  type Item,
  type ToolStep,
} from '@gratis-gis/shared-types';

/**
 * Read-only summary of a derived layer's recipe. Editing the recipe
 * (changing the source, tweaking buffer distance, adding tools) is
 * surfaced on the standard /edit screen, which renders the same
 * builder used by the new-item wizard. This panel just shows what
 * the layer is so a viewer or owner can understand it at a glance,
 * and shows the cached output schema so people binding dashboards
 * to it can see the columns without running a query.
 *
 * Source title resolution is best-effort: a missing / unshared /
 * trashed source renders the bare UUID with a warning rather than
 * blocking the panel.
 */
export function DerivedLayerDetail({
  data,
}: {
  data: DerivedLayerData;
}) {
  const [sourceItem, setSourceItem] = useState<Item | null>(null);
  const [sourceErr, setSourceErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!data.source.itemId) return;
    fetch(`/api/portal/items/${data.source.itemId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as Item;
        if (!cancelled) setSourceItem(body);
      })
      .catch(() => {
        if (!cancelled) setSourceErr('Source layer not accessible.');
      });
    return () => {
      cancelled = true;
    };
  }, [data.source.itemId]);

  return (
    <section className="mb-6 space-y-6 rounded-lg border border-border bg-surface-1 p-4">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-700/90 text-white">
          <FlaskConical className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-medium text-ink-0">Recipe</h2>
          <p className="mt-1 text-xs text-muted">
            This layer is computed live: it stores the steps below and
            re-runs them on every read so it stays in sync with its
            source.
          </p>
        </div>
      </header>

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Source layer
        </h3>
        {sourceItem ? (
          <Link
            href={`/items/${sourceItem.id}`}
            className="inline-flex items-start gap-2 rounded-md border border-border bg-surface-0 px-3 py-2 text-sm hover:bg-surface-2"
          >
            <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink-0">
                {sourceItem.title}
              </span>
              {sourceItem.description ? (
                <span className="mt-0.5 block text-xs text-muted">
                  {sourceItem.description}
                </span>
              ) : null}
            </span>
          </Link>
        ) : sourceErr ? (
          <p className="text-xs text-danger">
            {sourceErr} The recipe still references{' '}
            <code>{data.source.itemId}</code>.
          </p>
        ) : (
          <p className="text-xs text-muted">Loading source layer…</p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Pipeline ({data.pipeline.length} step
          {data.pipeline.length === 1 ? '' : 's'})
        </h3>
        {data.pipeline.length === 0 ? (
          <p className="text-xs text-muted">
            No tool steps configured. The layer needs at least one
            step to return any features.
          </p>
        ) : (
          <ol className="space-y-1">
            {data.pipeline.map((step, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 px-3 py-2 text-sm"
              >
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-700/90 text-[11px] font-semibold text-white">
                  {idx + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="font-medium text-ink-0">
                    {labelForTool(step)}
                  </span>
                  <ArrowRight className="h-3 w-3 text-muted" />
                  <span className="text-xs text-muted">
                    {summarizeStep(step)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Output schema
        </h3>
        {data.outputSchema.length === 0 ? (
          <p className="text-xs text-muted">
            No fields recorded yet. Save the recipe (or wait for the
            server to recompute) to populate this list.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {data.outputSchema.map((f) => (
              <li
                key={f.name}
                className="flex items-baseline justify-between rounded-md border border-border bg-surface-0 px-2 py-1"
              >
                <span className="truncate font-medium text-ink-0">
                  {f.label || f.name}
                </span>
                <span className="ml-2 shrink-0 text-muted">{f.type}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="text-[11px] text-muted">
        Feature limit: {data.featureLimit.toLocaleString()} features per
        read.
      </div>
    </section>
  );
}

function labelForTool(step: ToolStep): string {
  switch (step.tool) {
    case 'buffer':
      return 'Buffer';
    case 'dissolve':
      return 'Dissolve';
    case 'centroid':
      return 'Centroid';
    case 'convex-hull':
      return 'Convex hull';
    case 'bbox':
      return 'Bounding box';
    case 'simplify':
      return 'Simplify';
    case 'vertices':
      return 'Vertices';
    case 'densify':
      return 'Densify';
    case 'top-n':
      return 'Top N';
    case 'random-sample':
      return 'Random sample';
    case 'nearest-neighbor':
      return 'Nearest-neighbor distance';
    case 'fishnet':
      return 'Fishnet';
    case 'calculate-geometry':
      return 'Calculate geometry';
    default:
      // Future tools land in this default until they grow a label;
      // shows the raw kind so the panel never goes silently blank
      // when a deployment is on a newer schema than the client.
      return (step as { tool: string }).tool;
  }
}

function summarizeStep(step: ToolStep): string {
  switch (step.tool) {
    case 'buffer': {
      const params = step.params;
      const unitLabel = UNIT_LABELS[params.unit] ?? params.unit;
      if (params.mode === 'field') {
        // Field-driven buffer: show which column the per-feature
        // distance reads from, the unit it's interpreted in, and the
        // server-computed cap so a viewer understands the upper
        // bound at a glance.
        const cap = formatCap(params.cachedMaxMeters);
        return `${params.field} (${unitLabel}, max ~${cap})`;
      }
      // Fixed: simple distance + unit.
      return `${params.distance.toLocaleString()} ${unitLabel}`;
    }
    case 'dissolve':
      // v1 dissolve has no params worth surfacing; the label
      // ("Dissolve") and the row's effect (drop attributes, merge
      // geometries) are explained in the design doc and the
      // builder's step editor.
      return 'merge all features';
    case 'centroid':
      return 'center point per feature';
    case 'convex-hull':
      return 'smallest enclosing convex polygon';
    case 'bbox':
      return 'axis-aligned bounding rectangle';
    case 'simplify': {
      const u = UNIT_LABELS[step.params.unit] ?? step.params.unit;
      return `tolerance ${step.params.tolerance.toLocaleString()} ${u}`;
    }
    case 'vertices':
      return 'one point per vertex';
    case 'densify': {
      const u = UNIT_LABELS[step.params.unit] ?? step.params.unit;
      return `max ${step.params.maxSegmentLength.toLocaleString()} ${u} per segment`;
    }
    case 'top-n': {
      const dir = step.params.direction === 'asc' ? 'lowest' : 'highest';
      return `${dir} ${step.params.n.toLocaleString()} by ${step.params.field}`;
    }
    case 'random-sample':
      return step.params.mode === 'percentage'
        ? `~${step.params.value}% of rows`
        : `${step.params.value.toLocaleString()} rows`;
    case 'nearest-neighbor':
      return 'distance to closest neighbor (m)';
    case 'fishnet': {
      const u = UNIT_LABELS[step.params.unit] ?? step.params.unit;
      return `${step.params.cellSize.toLocaleString()} ${u} cells (${step.params.output})`;
    }
    case 'calculate-geometry': {
      const u =
        step.params.measurement === 'area'
          ? AREA_UNIT_LABELS[step.params.unit] ?? step.params.unit
          : UNIT_LABELS[step.params.unit] ?? step.params.unit;
      return `${step.params.measurement} -> ${step.params.fieldName} (${u})`;
    }
    default:
      return '';
  }
}

/**
 * Format a meters cap for display. Compact: bare meters under 1 km,
 * km above. Used by the field-mode buffer summary so the cap reads
 * naturally regardless of magnitude.
 */
function formatCap(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters >= 1000) {
    return `${(meters / 1000).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} km`;
  }
  return `${Math.round(meters).toLocaleString()} m`;
}
