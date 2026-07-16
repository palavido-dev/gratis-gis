// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Tool picker + inline "Create new tool" path used by the Button
 * widget config in the Custom Web App designer (#90).
 *
 * Replaces the bare paste-an-id input the Button widget used to
 * have for `linkKind: 'tool'`.  Two affordances:
 *
 *   1. A combobox listing the tool items the user can read in
 *      their org (sorted by title).  Picking one stamps its id
 *      into the button's toolId.
 *
 *   2. A "+ Create new tool" button that opens an inline modal.
 *      The author types a title, picks a starter template, and
 *      hits Create -- the modal POSTs a new tool item, then
 *      automatically selects it on the Button widget so the user
 *      can drop the button on the canvas immediately.  The new
 *      tool exists as a normal item so it can be edited, shared,
 *      and reused from other apps.
 *
 * Future polish (filed as follow-ups):
 *   - Pre-bind feature-source parameters bound to runtime-host to
 *     specific layers from the current app's maps at create time.
 *     The user can do this today after creation by editing the
 *     tool's recipe; the inline modal stays focused on "stamp out a
 *     working starter" rather than a full second designer surface.
 *   - Auto-refresh the combobox when a new tool is created outside
 *     this picker.  Today the user has to reopen the widget config
 *     pane to see externally-created tools; not blocking.
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  RECIPE_TEMPLATES,
  type RecipeAction,
  type ToolItemData,
} from '@gratis-gis/shared-types';

interface ToolOption {
  id: string;
  title: string;
}

interface Props {
  selectedId: string;
  canEdit: boolean;
  onSelect: (id: string) => void;
}

export function ToolPicker({ selectedId, canEdit, onSelect }: Props) {
  const [available, setAvailable] = useState<ToolOption[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=tool', {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setAvailable([]);
          return;
        }
        const rows = (await res.json()) as Array<{ id: string; title: string }>;
        if (!cancelled) {
          setAvailable(
            rows
              .map((r) => ({ id: r.id, title: r.title }))
              .sort((a, b) => a.title.localeCompare(b.title)),
          );
        }
      } catch {
        if (!cancelled) setAvailable([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  return (
    <>
      <div className="flex items-center gap-2">
        <select
          value={selectedId}
          disabled={!canEdit || available === null}
          onChange={(e) => onSelect(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          {available === null ? (
            <option value="">Loading…</option>
          ) : (
            <>
              <option value="">(pick a tool)</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
              {selectedId && !available.some((t) => t.id === selectedId) ? (
                // The widget references an id the user can't see in
                // their accessible list.  Surface it so editing the
                // widget doesn't silently drop the binding.
                <option value={selectedId} key="__unknown">
                  (unknown tool · {selectedId.slice(0, 8)}…)
                </option>
              ) : null}
            </>
          )}
        </select>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1 hover:bg-surface-2"
            title="Create a new tool inline"
          >
            <Plus className="h-3.5 w-3.5" />
            New tool
          </button>
        ) : null}
      </div>
      {createOpen ? (
        <CreateToolModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            onSelect(id);
            setLoadKey((k) => k + 1);
            setCreateOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

// ---- Inline create modal --------------------------------------------------

function CreateToolModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('Select By Location');
  const [templateId, setTemplateId] = useState<string>(
    RECIPE_TEMPLATES[0]?.id ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    const template = RECIPE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      setError('Pick a template.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // RecipeTemplate.build() returns `RecipeAction |
      // OsmRelationalQueryAction` (#142): the picker just stamps
      // whichever shape the template emits.  ToolItemData.action
      // accepts the broader ToolAction union anyway.
      const action = template.build();
      const data: ToolItemData = {
        schemaVersion: 1,
        action,
        hint: template.description,
      };
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'tool',
          title: title.trim(),
          description: template.description,
          data,
        }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const body = (await res.json()) as { id: string };
      onCreated(body.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-tool-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4 py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface-0 p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="create-tool-title" className="text-sm font-medium text-ink-0">
              New tool
            </h2>
            <p className="text-[11px] text-muted">
              Stamp out a working tool item from a starter template.
              You can edit anything on the tool&apos;s detail page
              after it&apos;s saved.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-1 p-1 text-muted hover:text-ink-1"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-muted">
              Title
            </label>
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
              placeholder="Select By Location"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-muted">
              Starter template
            </label>
            <div className="mt-1 space-y-1">
              {RECIPE_TEMPLATES.map((tpl) => (
                <label
                  key={tpl.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                    templateId === tpl.id
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-surface-0 hover:bg-surface-1'
                  }`}
                >
                  <input
                    type="radio"
                    name="recipe-template"
                    checked={templateId === tpl.id}
                    onChange={() => setTemplateId(tpl.id)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="block font-medium text-ink-0">
                      {tpl.label}
                    </span>
                    <span className="block text-[10px] text-muted">
                      {tpl.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Create
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
