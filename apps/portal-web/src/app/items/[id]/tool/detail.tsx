// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Tool item detail editor (#90).
 *
 * Tools are reusable named actions you bind to a Button widget on
 * a Custom Web App.  This editor is minimal by design: the value
 * of tools-as-a-first-class-item is the REUSE, not a fancy form.
 * Authors pick a kind + fill in the kind's parameters + save; the
 * portal handles the rest (sharing, deletion, dependency tracking).
 *
 * v1 actions:
 *   - open-item: navigate to /items/<id>[?view=...]
 *   - open-url:  open an absolute URL
 *
 * Both can choose same-tab vs new-tab.  Future actions (run a
 * derived-layer pipeline, kick a print, run a server-side
 * transformation) plug into the same switch with no UI churn for
 * tools that already exist on disk.
 */

import { useEffect, useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import {
  emptyOsmRelationalQueryAction,
  emptyRecipeAction,
  emptyToolData,
  type OsmRelationalQueryAction,
  type RecipeAction,
  type ToolAction,
  type ToolItemData,
} from '@gratis-gis/shared-types';

import { RecipeEditor } from './recipe-editor';
import { OsmRelationalEditor } from './osm-relational-editor';

interface Props {
  itemId: string;
  initial: ToolItemData | null;
  canEdit: boolean;
}

export function ToolDetail({ itemId, initial, canEdit }: Props) {
  // Normalize legacy / undefined data into a fresh blob so the
  // controlled inputs always have a defined value.  Older drafts
  // saved as `null`; new tools land via emptyToolData().
  const [data, setData] = useState<ToolItemData>(
    () => initial ?? emptyToolData(),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) setData(initial);
  }, [initial]);

  function patchAction(patch: Partial<ToolAction>): void {
    setData((d) => ({ ...d, action: { ...d.action, ...patch } as ToolAction }));
  }

  function switchKind(kind: ToolAction['kind']): void {
    if (kind === data.action.kind) return;
    setData((d) => {
      let action: ToolAction;
      if (kind === 'open-item') {
        action = { kind: 'open-item', targetItemId: '', newTab: false };
      } else if (kind === 'export-layer') {
        action = {
          kind: 'export-layer',
          targetItemId: '',
          layerKey: '',
          format: 'xlsx',
        };
      } else if (kind === 'recipe') {
        action = emptyRecipeAction();
      } else if (kind === 'osm-relational-query') {
        action = emptyOsmRelationalQueryAction();
      } else {
        action = { kind: 'open-url', url: '', newTab: true };
      }
      return { ...d, action };
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const labelCls =
    'block text-xs font-medium uppercase tracking-wide text-muted';
  const inputCls =
    'mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-3 text-sm font-medium text-ink-0">Action</h2>
      <p className="mb-4 text-xs text-muted">
        Tools are reusable named actions.  Drop this tool onto a Custom Web
        App via a Button widget&apos;s &ldquo;Run tool&rdquo; mode and clicking the
        button runs whatever you configure here.
      </p>

      <div className="mb-4">
        <label className={labelCls}>Kind</label>
        <div className="mt-1 inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => switchKind('open-url')}
            className={`px-3 py-1 ${
              data.action.kind === 'open-url'
                ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                : 'text-muted'
            }`}
          >
            Open URL
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => switchKind('open-item')}
            className={`px-3 py-1 ${
              data.action.kind === 'open-item'
                ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                : 'text-muted'
            }`}
          >
            Open item
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => switchKind('export-layer')}
            className={`px-3 py-1 ${
              data.action.kind === 'export-layer'
                ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                : 'text-muted'
            }`}
          >
            Export layer
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => switchKind('recipe')}
            className={`px-3 py-1 ${
              data.action.kind === 'recipe'
                ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                : 'text-muted'
            }`}
          >
            Recipe
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => switchKind('osm-relational-query')}
            className={`px-3 py-1 ${
              data.action.kind === 'osm-relational-query'
                ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                : 'text-muted'
            }`}
          >
            OSM relational
          </button>
        </div>
      </div>

      {data.action.kind === 'open-url' ? (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>URL</label>
            <input
              type="url"
              disabled={!canEdit}
              value={data.action.url}
              onChange={(e) => patchAction({ url: e.target.value })}
              placeholder="https://example.org/page"
              className={inputCls}
            />
            <p className="mt-1 text-2xs text-muted">
              Absolute URL.  App-relative paths like
              <code className="mx-1 rounded bg-surface-2 px-1 font-mono">/items/&lt;id&gt;</code>
              also work for jumping to portal pages.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={!!data.action.newTab}
              onChange={(e) => patchAction({ newTab: e.target.checked })}
            />
            Open in a new tab
          </label>
        </div>
      ) : data.action.kind === 'recipe' ? (
        <RecipeEditor
          recipe={data.action}
          canEdit={canEdit}
          onChange={(next: RecipeAction) =>
            setData((d) => ({ ...d, action: next }))
          }
        />
      ) : data.action.kind === 'open-item' ? (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Target item id</label>
            <input
              type="text"
              disabled={!canEdit}
              value={data.action.targetItemId}
              onChange={(e) =>
                patchAction({ targetItemId: e.target.value.trim() })
              }
              placeholder="00000000-0000-0000-0000-000000000000"
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-2xs text-muted">
              The item id to navigate to.  Resolves to
              <code className="mx-1 rounded bg-surface-2 px-1 font-mono">/items/&lt;targetItemId&gt;</code>.
              A future iteration will replace this with an item picker.
            </p>
          </div>
          <div>
            <label className={labelCls}>View (optional)</label>
            <input
              type="text"
              disabled={!canEdit}
              value={data.action.view ?? ''}
              onChange={(e) => {
                // exactOptionalPropertyTypes: we can't assign
                // `undefined` to an optional `string` field, so
                // strip the key entirely when the user clears it.
                const v = e.target.value.trim();
                setData((d) => {
                  if (d.action.kind !== 'open-item') return d;
                  const next: typeof d.action = { ...d.action };
                  if (v) next.view = v;
                  else delete next.view;
                  return { ...d, action: next };
                });
              }}
              placeholder="configure, run, …"
              className={inputCls}
            />
            <p className="mt-1 text-2xs text-muted">
              Appends <code className="mx-1 rounded bg-surface-2 px-1 font-mono">?view=&lt;value&gt;</code>
              to the URL.  Useful for jumping straight into a builder
              or a runtime view of a multi-mode item.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={!!data.action.newTab}
              onChange={(e) => patchAction({ newTab: e.target.checked })}
            />
            Open in a new tab
          </label>
        </div>
      ) : data.action.kind === 'export-layer' ? (
        // Export-layer action.  When the button bound to this tool
        // is clicked, the runtime fetches the configured sublayer's
        // features via the API and triggers a CSV / XLSX download.
        // Item picker is paste-an-id today; a future revision can
        // swap in a data_layer combobox.
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Data layer item id</label>
            <input
              type="text"
              disabled={!canEdit}
              value={data.action.targetItemId}
              onChange={(e) =>
                patchAction({ targetItemId: e.target.value.trim() })
              }
              placeholder="00000000-0000-0000-0000-000000000000"
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-2xs text-muted">
              The data_layer item id whose features to export.
            </p>
          </div>
          <div>
            <label className={labelCls}>Sublayer key</label>
            <input
              type="text"
              disabled={!canEdit}
              value={data.action.layerKey}
              onChange={(e) =>
                patchAction({ layerKey: e.target.value.trim() })
              }
              placeholder="lyr_xxxxxxxx"
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-2xs text-muted">
              The sublayer id inside the data layer (visible on the
              data layer&apos;s detail page).  v3 layers are multi-
              layer so you pick a specific sublayer here.
            </p>
          </div>
          <div>
            <label className={labelCls}>Format</label>
            <div className="mt-1 inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => patchAction({ format: 'xlsx' })}
                className={`px-3 py-1 ${
                  data.action.format === 'xlsx'
                    ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                    : 'text-muted'
                }`}
              >
                Excel (.xlsx)
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => patchAction({ format: 'csv' })}
                className={`px-3 py-1 ${
                  data.action.format === 'csv'
                    ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                    : 'text-muted'
                }`}
              >
                CSV
              </button>
            </div>
          </div>
        </div>
      ) : data.action.kind === 'osm-relational-query' ? (
        <OsmRelationalEditor
          action={data.action}
          canEdit={canEdit}
          onChange={(next: OsmRelationalQueryAction) =>
            setData((d) => ({ ...d, action: next }))
          }
        />
      ) : null}

      <div className="mt-4 border-t border-border pt-3">
        <label className={labelCls}>Hint (optional)</label>
        <input
          type="text"
          disabled={!canEdit}
          value={data.hint ?? ''}
          onChange={(e) => {
            // exactOptionalPropertyTypes: strip the `hint` key
            // entirely when the user clears it instead of assigning
            // `undefined` (which fails the strict check).
            const v = e.target.value;
            setData((d) => {
              const next = { ...d };
              if (v) next.hint = v;
              else delete next.hint;
              return next;
            });
          }}
          placeholder="Short description shown in tool pickers"
          className={inputCls}
        />
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {canEdit ? (
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </button>
          {savedAt ? (
            <span className="text-xs text-muted">
              Saved {savedAt.toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted">
          You have view-only access to this tool.
        </p>
      )}
    </div>
  );
}
