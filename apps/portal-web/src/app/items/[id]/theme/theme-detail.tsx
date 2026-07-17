// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #54: theme item detail editor + live preview.
 *
 * Two-pane layout: editable color/geometry controls on the left,
 * a sample app shell on the right that restyles in real time as
 * the author changes tokens.  CSS custom properties on the shell's
 * root container drive every nested widget's styling, same way
 * the Custom Web App runtime applies a theme; the shell here just
 * renders against those tokens.  No raw CSS variable names in the
 * UI -- the editor speaks "Header background", "Body text", etc.
 *
 * Tokens are stored on the item's `data` blob as bare HSL
 * components (`"150 22% 38%"`).  The color picker converts to/from
 * hex so the native <input type="color"> is usable; non-color
 * tokens (radius, density) take a slider + numeric input.  Save
 * PATCHes the item back through the BFF proxy.
 *
 * Read-only mode: viewers see the same preview but the editor
 * column shows a "you do not have permission to edit" notice and
 * the controls are disabled.  Picking + applying the theme from a
 * Custom Web App still works regardless.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark as BookmarkIcon,
  ChevronDown,
  Layers as LayersIcon,
  Loader2,
  Palette,
  Printer,
  Save,
  Search,
} from 'lucide-react';

interface Blueprint {
  version?: number;
  swatch?: string;
  tokens?: Record<string, string>;
}

interface Props {
  itemId: string;
  initialBlueprint: Blueprint;
  seedKind: string | null;
  canEdit: boolean;
}

/**
 * Field descriptor for one editable token.  The `label` is the
 * human-readable name shown in the editor; `hint` explains where
 * in an app the token shows up (so a non-technical user can map
 * what they're changing back to what they see in the preview).
 */
interface FieldDef {
  /** CSS variable name (e.g. '--app-header-bg'). */
  key: string;
  label: string;
  hint: string;
  /** color: H/S/L triplet. length: CSS length. number: bare number. */
  kind: 'color' | 'length' | 'number';
}

interface GroupDef {
  label: string;
  description: string;
  fields: FieldDef[];
}

const GROUPS: GroupDef[] = [
  {
    label: 'Header',
    description:
      'The top app-bar of every web app using this theme. Carries the title and the toolbar icons.',
    fields: [
      {
        key: '--app-header-bg',
        label: 'Header background',
        hint: 'Fill behind the title and toolbar icons.',
        kind: 'color',
      },
      {
        key: '--app-header-ink',
        label: 'Header text',
        hint: 'Title text + toolbar icon color on the header.',
        kind: 'color',
      },
      {
        key: '--app-header-muted',
        label: 'Header subtitle',
        hint: 'Secondary text under the title (and inactive toolbar labels).',
        kind: 'color',
      },
      {
        key: '--app-header-border',
        label: 'Header bottom border',
        hint: 'The hairline between the header and the body.',
        kind: 'color',
      },
    ],
  },
  {
    label: 'Surfaces',
    description: 'Backgrounds for the page, cards, and popovers.',
    fields: [
      {
        key: '--app-surface-0',
        label: 'Page background',
        hint: 'Furthest-back surface; what shows between cards.',
        kind: 'color',
      },
      {
        key: '--app-surface-1',
        label: 'Card surface',
        hint: 'Background of widgets, dock panels, foldable groups.',
        kind: 'color',
      },
      {
        key: '--app-surface-2',
        label: 'Inputs + popovers',
        hint: 'Slightly elevated; inputs, hover states, popover bodies.',
        kind: 'color',
      },
    ],
  },
  {
    label: 'Body text',
    description: 'Text and dividers on the body surfaces (not the header).',
    fields: [
      {
        key: '--app-ink-0',
        label: 'Heading text',
        hint: 'Card titles, primary labels.',
        kind: 'color',
      },
      {
        key: '--app-ink-1',
        label: 'Body text',
        hint: 'Regular paragraph and list text.',
        kind: 'color',
      },
      {
        key: '--app-muted',
        label: 'Muted text',
        hint: 'Captions, hints, inactive labels.',
        kind: 'color',
      },
      {
        key: '--app-border',
        label: 'Border',
        hint: 'Dividers between rows, around inputs, edges of cards.',
        kind: 'color',
      },
    ],
  },
  {
    label: 'Accent',
    description: 'The brand color for buttons, focus rings, and active states.',
    fields: [
      {
        key: '--app-accent',
        label: 'Accent',
        hint: 'Primary button fill, active tab, focus ring.',
        kind: 'color',
      },
      {
        key: '--app-accent-ink',
        label: 'Accent text',
        hint: 'Text color used ON top of the accent fill.',
        kind: 'color',
      },
      {
        key: '--app-accent-hover',
        label: 'Accent hover',
        hint: 'Darker accent shown on hover.',
        kind: 'color',
      },
    ],
  },
  {
    label: 'Status',
    description:
      'Standardized colors for success, warning, danger, info badges.',
    fields: [
      { key: '--app-success', label: 'Success', hint: 'OK / saved / done.', kind: 'color' },
      { key: '--app-warn', label: 'Warning', hint: 'Caution, expiring.', kind: 'color' },
      { key: '--app-danger', label: 'Danger', hint: 'Delete, error, blocked.', kind: 'color' },
      { key: '--app-info', label: 'Info', hint: 'Notes, neutral signals.', kind: 'color' },
    ],
  },
  {
    label: 'Geometry',
    description:
      'Non-color knobs: corner radius and density (how much padding).',
    fields: [
      {
        key: '--app-radius',
        label: 'Corner radius',
        hint: 'How rounded card and button corners are.',
        kind: 'length',
      },
      {
        key: '--app-density',
        label: 'Density',
        hint: 'Spacing multiplier; values <1 are tighter, >1 are airier.',
        kind: 'number',
      },
    ],
  },
];

export function AppThemeDetail({
  itemId,
  initialBlueprint,
  seedKind,
  canEdit,
}: Props) {
  const [tokens, setTokens] = useState<Record<string, string>>(
    initialBlueprint.tokens ?? {},
  );
  const [swatch, setSwatch] = useState<string>(
    initialBlueprint.swatch ?? 'hsl(210 40% 96%)',
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the first group ('Header') is open by default; the page was
  // getting too scrolly with every group expanded.
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set<string>([GROUPS[0]!.label]),
  );

  function toggleGroup(label: string): void {
    setOpenGroups((cur) => {
      const next = new Set(cur);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  // Apply tokens to the preview root on every change so the
  // sample app shell restyles instantly.  Same applier the runtime
  // uses (just inlined to avoid the shared-types dep cycle on this
  // client-only file).
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = previewRootRef.current;
    if (!el) return;
    for (const [k, v] of Object.entries(tokens)) {
      el.style.setProperty(k, v);
    }
  }, [tokens]);

  function patchToken(key: string, next: string): void {
    setTokens((cur) => ({ ...cur, [key]: next }));
    setDirty(true);
    setSaved(false);
  }

  // When the accent color changes, the saved-theme swatch the
  // picker shows in the Custom Web App designer should follow it.
  // Default behavior: if the swatch matches the previous accent,
  // mirror to the new accent.  Authors who want a stable swatch
  // can edit it via the swatch field directly (added inline below).
  function patchAccentAndMaybeSwatch(hex: string): void {
    const prevAccent = tokens['--app-accent'];
    const prevSwatch = swatch;
    const nextHsl = hexToHsl(hex);
    setTokens((cur) => ({ ...cur, '--app-accent': nextHsl }));
    if (prevAccent && prevSwatch === `hsl(${prevAccent})`) {
      setSwatch(`hsl(${nextHsl})`);
    }
    setDirty(true);
    setSaved(false);
  }

  async function onSave(): Promise<void> {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: { version: 1, swatch, tokens },
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status} ${txt}`);
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface-1 shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-pink-500/10 text-pink-600 dark:text-pink-400">
          <Palette className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">Theme</p>
          <h2 className="text-base font-semibold text-ink-0">
            Reusable color palette
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {seedKind ? `Built-in starter (${seedKind}).` : 'User-saved theme.'}{' '}
            Edit any of the colors on the left and the preview on
            the right updates immediately. Save when you&apos;re happy.
          </p>
        </div>
        <span
          aria-hidden
          className="h-9 w-9 shrink-0 rounded-md border border-border"
          style={{ background: swatch }}
          title={`Picker swatch: ${swatch}`}
        />
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs font-medium text-success">Saved</span>
          )}
          {error && (
            <span
              className="max-w-[14rem] truncate text-xs text-danger"
              title={error}
            >
              {error}
            </span>
          )}
          <button
            type="button"
            disabled={!canEdit || !dirty || saving}
            onClick={onSave}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
              !canEdit || !dirty || saving
                ? 'cursor-not-allowed bg-surface-2 text-muted'
                : 'bg-accent text-accent-ink hover:bg-accent/90'
            }`}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </header>

      <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)]">
        {/* ---- Editor pane ---- */}
        <div className="space-y-4">
          {!canEdit && (
            <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
              Read-only. You need item-manage rights to edit the
              colors below.
            </div>
          )}
          {GROUPS.map((g) => {
            const open = openGroups.has(g.label);
            return (
              <div key={g.label} className="rounded-md border border-border bg-surface-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(g.label)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-surface-2/60"
                  aria-expanded={open}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${
                      open ? '' : '-rotate-90'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-0">
                      {g.label}
                    </p>
                    {!open && (
                      <p className="truncate text-2xs text-muted">
                        {g.description}
                      </p>
                    )}
                  </div>
                  <span className="text-2xs text-muted">
                    {g.fields.length}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-border px-1.5 pb-1.5">
                    <p className="px-1 py-1.5 text-2xs text-muted">
                      {g.description}
                    </p>
                    <div className="space-y-1.5">
                      {g.fields.map((f) => (
                        <TokenRow
                          key={f.key}
                          field={f}
                          value={tokens[f.key] ?? ''}
                          canEdit={canEdit}
                          onChange={(v) =>
                            f.key === '--app-accent'
                              ? patchAccentAndMaybeSwatch(v)
                              : patchToken(
                                  f.key,
                                  f.kind === 'color' ? hexToHsl(v) : v,
                                )
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- Preview pane ---- */}
        <div
          ref={previewRootRef}
          className="overflow-hidden rounded-lg border border-border"
          style={{ background: 'hsl(var(--app-surface-0))' }}
        >
          <SampleAppShell />
        </div>
      </div>
    </section>
  );
}

// ---- Editor row ------------------------------------------------

function TokenRow({
  field,
  value,
  canEdit,
  onChange,
}: {
  field: FieldDef;
  value: string;
  canEdit: boolean;
  onChange: (next: string) => void;
}) {
  if (field.kind === 'color') {
    const hex = hslToHex(value) || '#cccccc';
    return (
      <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2/60">
        <label className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border">
          <input
            type="color"
            disabled={!canEdit}
            value={hex}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-7 cursor-pointer opacity-0"
            aria-label={field.label}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute h-5 w-5 rounded border border-border"
            style={{ background: hex }}
          />
        </label>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-ink-0">
            {field.label}
          </p>
          <p className="truncate text-2xs text-muted">{field.hint}</p>
        </div>
        <span className="font-mono text-2xs text-muted">{hex}</span>
      </div>
    );
  }
  // Non-color: text input with the token's raw value.  Keeps the
  // editor uncomplicated for radius / density which the user
  // typically tweaks rarely.
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2/60">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-2xs text-muted">
        {field.kind === 'length' ? 'rem' : '#'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink-0">{field.label}</p>
        <p className="truncate text-2xs text-muted">{field.hint}</p>
      </div>
      <input
        type="text"
        disabled={!canEdit}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 rounded border border-border bg-surface-1 px-2 py-0.5 font-mono text-2xs"
      />
    </div>
  );
}

// ---- Sample app shell ------------------------------------------

/**
 * A miniature live preview that exercises every token in the
 * editor.  Mirrors the structure of a real Custom Web App: app-bar
 * with title + tools, left dock with a Layers foldable, fake map
 * area with status badges + accent button overlay.
 */
function SampleAppShell() {
  return (
    <div
      className="flex h-[420px] flex-col"
      style={{ background: 'hsl(var(--app-surface-0))' }}
    >
      {/* App bar */}
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
        style={{
          background: 'hsl(var(--app-header-bg))',
          borderColor: 'hsl(var(--app-header-border))',
          color: 'hsl(var(--app-header-ink))',
        }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Sample app</p>
          <p
            className="truncate text-2xs"
            style={{ color: 'hsl(var(--app-header-muted))' }}
          >
            Live preview of this theme
          </p>
        </div>
        <ToolbarIcon label="Search" Icon={Search} />
        <ToolbarIcon label="Layers" Icon={LayersIcon} active />
        <ToolbarIcon label="Print" Icon={Printer} />
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Left dock */}
        <aside
          className="flex w-44 shrink-0 flex-col border-r"
          style={{
            background: 'hsl(var(--app-surface-1))',
            borderColor: 'hsl(var(--app-border))',
          }}
        >
          <div
            className="border-b px-3 py-2"
            style={{ borderColor: 'hsl(var(--app-border))' }}
          >
            <p
              className="text-2xs font-semibold uppercase tracking-wide"
              style={{ color: 'hsl(var(--app-muted))' }}
            >
              Layers
            </p>
          </div>
          <ul
            className="flex-1 divide-y text-xs"
            style={{ borderColor: 'hsl(var(--app-border))' }}
          >
            {[
              { color: 'hsl(var(--app-accent))', label: 'Parcels' },
              { color: 'hsl(var(--app-info))', label: 'Streams' },
              { color: 'hsl(var(--app-success))', label: 'Reserves' },
            ].map((l) => (
              <li
                key={l.label}
                className="flex items-center gap-2 px-3 py-2"
                style={{
                  borderColor: 'hsl(var(--app-border))',
                  color: 'hsl(var(--app-ink-1))',
                }}
              >
                <input
                  type="checkbox"
                  defaultChecked
                  readOnly
                  className="h-3 w-3"
                />
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 shrink-0 rounded-sm border"
                  style={{
                    background: l.color,
                    borderColor: 'hsl(var(--app-border))',
                  }}
                />
                <span className="truncate">{l.label}</span>
              </li>
            ))}
          </ul>
          <div
            className="border-t px-3 py-2"
            style={{ borderColor: 'hsl(var(--app-border))' }}
          >
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
              style={{
                background: 'hsl(var(--app-accent))',
                color: 'hsl(var(--app-accent-ink))',
                borderRadius: 'var(--app-radius)',
              }}
            >
              <BookmarkIcon className="h-3.5 w-3.5" />
              Action button
            </button>
          </div>
        </aside>

        {/* Map area */}
        <div
          className="relative flex flex-1 items-center justify-center text-xs"
          style={{
            color: 'hsl(var(--app-muted))',
            background:
              'linear-gradient(135deg, hsl(var(--app-surface-0)) 0%, hsl(var(--app-surface-2)) 100%)',
          }}
        >
          <span>Map area</span>
          {/* Status chips floating in the map area */}
          <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-1.5">
            <StatusChip kind="success">Saved</StatusChip>
            <StatusChip kind="warn">Stale</StatusChip>
            <StatusChip kind="danger">Error</StatusChip>
            <StatusChip kind="info">Info</StatusChip>
          </div>
          {/* Popover preview */}
          <div
            className="absolute right-3 top-3 w-44 rounded-md border p-2 text-2xs shadow-md"
            style={{
              background: 'hsl(var(--app-surface-2))',
              borderColor: 'hsl(var(--app-border))',
              color: 'hsl(var(--app-ink-1))',
              borderRadius: 'var(--app-radius)',
            }}
          >
            <p
              className="font-semibold"
              style={{ color: 'hsl(var(--app-ink-0))' }}
            >
              Popover title
            </p>
            <p className="mt-1" style={{ color: 'hsl(var(--app-muted))' }}>
              Inputs and overlays use this surface.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarIcon({
  label,
  Icon,
  active,
}: {
  label: string;
  Icon: typeof Search;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      className="flex h-9 min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-md px-2"
      style={
        active
          ? {
              background: 'hsl(var(--app-header-ink))',
              color: 'hsl(var(--app-header-bg))',
            }
          : { color: 'hsl(var(--app-header-ink) / 0.85)' }
      }
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="text-2xs">{label}</span>
    </button>
  );
}

function StatusChip({
  kind,
  children,
}: {
  kind: 'success' | 'warn' | 'danger' | 'info';
  children: React.ReactNode;
}) {
  const palette: Record<typeof kind, string> = {
    success: 'hsl(var(--app-success))',
    warn: 'hsl(var(--app-warn))',
    danger: 'hsl(var(--app-danger))',
    info: 'hsl(var(--app-info))',
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium"
      style={{
        background: `${palette[kind]} / 0.15` as unknown as string,
        backgroundColor: palette[kind].replace(
          'hsl(',
          'hsla(',
        ).replace(')', ' / 0.15)'),
        color: palette[kind],
      }}
    >
      {children}
    </span>
  );
}

// ---- HSL <-> hex conversion ------------------------------------

/**
 * Convert a bare HSL triplet (`"150 22% 38%"`) to a #rrggbb hex
 * string the native `<input type="color">` consumes.  Returns
 * empty string for values the parser doesn't recognize so the
 * caller can fall back to a default.
 */
function hslToHex(triplet: string): string {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(
    triplet,
  );
  if (!m) return '';
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))) | 0;
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Inverse: hex -> bare HSL triplet for storage.  Rounds H to
 * an integer and S/L to a percentage so the saved values stay
 * clean.
 */
function hexToHsl(hex: string): string {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1]!, 16) / 255;
  const g = parseInt(m[2]!, 16) / 255;
  const b = parseInt(m[3]!, 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// Suppress the unused-var warning on useMemo since I dropped the
// memo wrapper in the final shape but kept the import for future use.
void useMemo;
