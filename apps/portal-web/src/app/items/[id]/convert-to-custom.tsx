// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles, X } from 'lucide-react';
import type {
  CustomAppData,
  CustomLayout,
  CustomPage,
  CustomWidget,
  EditorTarget,
  ViewerTarget,
  WebAppData,
} from '@gratis-gis/shared-types';
import { DEFAULT_CUSTOM_APP } from '@gratis-gis/shared-types';

interface Props {
  itemId: string;
  /** Source template the item is being converted from. Drives the
   *  pre-seeded widget set so the converted app feels like a richer
   *  version of the same thing rather than a blank page. */
  sourceTemplate: 'editor' | 'viewer';
  /** Reference map id to carry over (if set on the source). */
  sourceMapId?: string | undefined;
  /** Targets to carry over. Editor sources pass EditorTarget[];
   *  viewer passes ViewerTarget[] -- both shapes share the identity
   *  fields (dataLayerId + layerKey) that CustomAppData's targets
   *  use, so we accept either and project. */
  sourceTargets: Array<EditorTarget | ViewerTarget>;
}

/**
 * "Convert to custom web app" escape hatch (#282). Sits on the
 * Editor / Viewer detail pages and offers an irreversible one-click
 * conversion of the item's template to 'custom'. After the swap,
 * the same item id keeps working but the detail page now renders
 * the custom-app designer instead of the focused configurator.
 *
 * The conversion seeds the new CustomAppData with:
 *   1. mapId carried over (if any)
 *   2. targets carried over (identity fields only, drops editor's
 *      per-target permission flags since they don't apply to a
 *      generic custom app)
 *   3. one starter page with a full-bleed map widget + a layer-list
 *      widget on the side, sized into the 12-column grid.
 *
 * After PATCH the page reloads so the detail-page dispatch picks
 * the new template branch up.
 *
 * Why a "danger" treatment: the conversion is one-way today. The
 * focused configurator's data shape (e.g. Editor's per-target
 * canEditAttributes flags) is dropped. We could persist a
 * "previous" snapshot for restore in a follow-up, but that's
 * beyond the scope of this slice.
 */
export function ConvertToCustomButton({
  itemId,
  sourceTemplate,
  sourceMapId,
  sourceTargets,
}: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Project the source targets onto ViewerTarget identity fields.
      // EditorTarget carries extra flags we deliberately drop; the
      // resulting custom app is a "viewer-like" superset.
      const targets: ViewerTarget[] = sourceTargets.map((t) => ({
        dataLayerId: t.dataLayerId,
        layerKey: t.layerKey,
      }));

      const fullLayout: CustomLayout = {
        col: 1,
        row: 1,
        colSpan: 9,
        rowSpan: 8,
      };
      const sideLayout: CustomLayout = {
        col: 10,
        row: 1,
        colSpan: 3,
        rowSpan: 8,
      };
      const tableLayout: CustomLayout = {
        col: 1,
        row: 9,
        colSpan: 12,
        rowSpan: 4,
      };

      const widgets: CustomWidget[] = [];
      const mapWidgetId = `w_map_${rid()}`;
      widgets.push({
        id: mapWidgetId,
        kind: 'map',
        layout: fullLayout,
        config: { kind: 'map', showNavigation: true },
      });
      widgets.push({
        id: `w_lyr_${rid()}`,
        kind: 'layer-list',
        layout: sideLayout,
        config: {
          kind: 'layer-list',
          mapWidgetId,
          allowToggle: true,
        },
      });
      // tableLayout retained for future per-template seeding -- the
      // legacy Survey branch used it; today Editor / Viewer skip a
      // pre-seeded attribute table because their target sets are
      // typically larger and the bottom-row table would crowd out
      // the map. The author can drop one in from the page editor.
      void tableLayout;

      const page: CustomPage = {
        id: 'home',
        title: 'Home',
        widgets,
      };
      const custom: CustomAppData = {
        ...DEFAULT_CUSTOM_APP,
        ...(sourceMapId ? { mapId: sourceMapId } : {}),
        targets,
        pages: [page],
      };
      const data: WebAppData = {
        version: 1,
        template: 'custom',
        config: { template: 'custom', custom },
      };

      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`convert failed: ${res.status} ${txt}`);
      }
      // Reload so the detail page rebinds to the custom branch and
      // the runtime href changes from /<template>/run to /custom/run.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'convert failed');
      setSubmitting(false);
    }
  }, [itemId, sourceMapId, sourceTargets, sourceTemplate]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
        title="Convert this app to a free-form Custom Web App layout"
      >
        <Sparkles className="h-3.5 w-3.5 text-warn" />
        Convert to custom
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-surface-1 p-5 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-ink-0">
                  <Sparkles className="h-4 w-4 text-warn" />
                  Convert to custom web app?
                </h3>
                <p className="mt-1 text-xs text-muted">
                  This is a one-way swap. The {labelFor(sourceTemplate)}{' '}
                  configurator will be replaced with the drag-drop
                  designer. Map binding and layers carry over; per-target
                  permission flags and template-specific knobs are dropped.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink-0"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {error && (
              <div className="mt-3 inline-flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-warn/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Convert
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function labelFor(t: 'editor' | 'viewer'): string {
  return t === 'editor' ? 'Editor' : 'Viewer';
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
