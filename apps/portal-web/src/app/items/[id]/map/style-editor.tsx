// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  DashStyle,
  LineCap,
  LineJoin,
  MapLayerStyle,
  PointSymbol,
} from '@gratis-gis/shared-types';
import {
  DASH_STYLES,
  LINE_CAPS,
  LINE_JOINS,
  dashStyleLabel,
} from '@gratis-gis/shared-types';
import type { GeometryFamily } from './layer-metadata';
import {
  MAP_ICONS,
  MAP_ICON_CATEGORIES,
  renderIconSvg,
} from './map-icons';

interface Props {
  value: MapLayerStyle;
  onChange: (next: MapLayerStyle) => void;
  /**
   * Which geometry families to surface. Empty (or undefined) means
   * "show everything": appropriate while metadata is still loading.
   * Once the layer's data is sampled we narrow to only what's present.
   */
  geometryTypes?: Set<GeometryFamily>;
  /**
   * Attribute names sampled from the layer's data, for the 3D
   * extrusion height-field picker. Empty while metadata loads;
   * the picker degrades to a free-text input so the control never
   * dead-ends.
   */
  fields?: string[];
}

/**
 * Simple renderer editor. Shows one section per geometry family that
 * the layer's data actually contains. When the metadata sampler hasn't
 * told us what's in the source yet, we fall back to showing all three
 * so a brand-new layer isn't missing controls: geometry narrowing
 * takes over as soon as the first sample comes back.
 *
 * Deliberately spartan: color + size are 80% of styling decisions.
 * Unique-value / class-break renderers ship as a separate panel.
 */
export function StyleEditor({ value, onChange, geometryTypes, fields }: Props) {
  function patch<K extends keyof MapLayerStyle>(
    section: K,
    patch: Partial<MapLayerStyle[K]>,
  ) {
    onChange({
      ...value,
      [section]: { ...value[section], ...patch },
    });
  }

  const showAll = !geometryTypes || geometryTypes.size === 0;
  const showPolygon = showAll || geometryTypes.has('polygon');
  const showLine = showAll || geometryTypes.has('line');
  const showPoint = showAll || geometryTypes.has('point');

  return (
    <div className="space-y-4">
      {showPolygon ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Polygons
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Fill"
            value={value.polygon.fillColor}
            onChange={(c) => patch('polygon', { fillColor: c })}
          />
          <Slider
            label="Fill opacity"
            min={0}
            max={1}
            step={0.05}
            value={value.polygon.fillOpacity}
            onChange={(n) => patch('polygon', { fillOpacity: n })}
          />
          <Color
            label="Outline"
            value={value.polygon.strokeColor}
            onChange={(c) => patch('polygon', { strokeColor: c })}
          />
          <Slider
            label="Outline width"
            min={0}
            max={8}
            step={0.5}
            value={value.polygon.strokeWidth}
            onChange={(n) => patch('polygon', { strokeWidth: n })}
          />
          {/* Dash style / cap / join (#73). Defaults to solid /
              round / round so existing polygons keep their look
              when this section appears below the size sliders. */}
          <DashSelect
            label="Outline dash"
            value={value.polygon.strokeDashStyle ?? 'solid'}
            onChange={(d) => patch('polygon', { strokeDashStyle: d })}
          />
          <CapJoinSelect
            label="Outline cap"
            options={LINE_CAPS}
            value={value.polygon.strokeCap ?? 'round'}
            onChange={(c) => patch('polygon', { strokeCap: c as LineCap })}
          />
          <CapJoinSelect
            label="Outline join"
            options={LINE_JOINS}
            value={value.polygon.strokeJoin ?? 'round'}
            onChange={(j) => patch('polygon', { strokeJoin: j as LineJoin })}
          />
        </div>

        {/* 3D extrusion by attribute. Renders via MapLibre's native
            fill-extrusion (no heavy 3D stack): building footprints
            with a height field, parcels by assessed value, etc.
            Tilt the map to see it. */}
        <div className="mt-3 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              checked={value.polygon.extrusion?.enabled ?? false}
              onChange={(e) =>
                patch('polygon', {
                  extrusion: {
                    enabled: e.target.checked,
                    heightField:
                      value.polygon.extrusion?.heightField ??
                      fields?.[0] ??
                      '',
                    heightMultiplier:
                      value.polygon.extrusion?.heightMultiplier ?? 1,
                    base: value.polygon.extrusion?.base ?? 0,
                  },
                })
              }
              className="accent-accent"
            />
            Extrude in 3D by attribute
          </label>
          {value.polygon.extrusion?.enabled ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="col-span-2 block">
                <span className="mb-1 block text-2xs uppercase tracking-wide text-muted">
                  Height field (meters)
                </span>
                {fields && fields.length > 0 ? (
                  <select
                    value={value.polygon.extrusion.heightField}
                    onChange={(e) =>
                      patch('polygon', {
                        extrusion: {
                          ...value.polygon.extrusion!,
                          heightField: e.target.value,
                        },
                      })
                    }
                    className="w-full rounded border border-border bg-surface-0 px-1.5 py-1 text-xs text-ink-0"
                  >
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={value.polygon.extrusion.heightField}
                    placeholder="e.g. height"
                    onChange={(e) =>
                      patch('polygon', {
                        extrusion: {
                          ...value.polygon.extrusion!,
                          heightField: e.target.value,
                        },
                      })
                    }
                    className="w-full rounded border border-border bg-surface-0 px-1.5 py-1 text-xs text-ink-0"
                  />
                )}
              </label>
              <Slider
                label="Multiplier"
                min={0.1}
                max={20}
                step={0.1}
                value={value.polygon.extrusion.heightMultiplier ?? 1}
                onChange={(n) =>
                  patch('polygon', {
                    extrusion: {
                      ...value.polygon.extrusion!,
                      heightMultiplier: n,
                    },
                  })
                }
              />
              <Slider
                label="Base offset (m)"
                min={0}
                max={100}
                step={1}
                value={value.polygon.extrusion.base ?? 0}
                onChange={(n) =>
                  patch('polygon', {
                    extrusion: {
                      ...value.polygon.extrusion!,
                      base: n,
                    },
                  })
                }
              />
              <p className="col-span-2 text-2xs leading-relaxed text-muted">
                Values in feet? Set the multiplier to 0.3048. Tilt
                the map (right-click drag) to see the extrusion.
              </p>
            </div>
          ) : null}
        </div>
      </section>
      ) : null}

      {showLine ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Lines
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Color"
            value={value.line.color}
            onChange={(c) => patch('line', { color: c })}
          />
          <Slider
            label="Width"
            min={0.5}
            max={12}
            step={0.5}
            value={value.line.width}
            onChange={(n) => patch('line', { width: n })}
          />
          <DashSelect
            label="Dash"
            value={value.line.dashStyle ?? 'solid'}
            onChange={(d) => patch('line', { dashStyle: d })}
          />
          <CapJoinSelect
            label="Cap"
            options={LINE_CAPS}
            value={value.line.cap ?? 'round'}
            onChange={(c) => patch('line', { cap: c as LineCap })}
          />
          <CapJoinSelect
            label="Join"
            options={LINE_JOINS}
            value={value.line.join ?? 'round'}
            onChange={(j) => patch('line', { join: j as LineJoin })}
          />
        </div>
      </section>
      ) : null}

      {showPoint ? (
        <section>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Points
          </h4>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <SymbolBtn
              active={(value.point.symbol ?? 'circle') === 'circle'}
              onClick={() => patch('point', { symbol: 'circle' })}
              label="Circle"
            />
            <SymbolBtn
              active={value.point.symbol === 'icon'}
              onClick={() =>
                patch('point', {
                  symbol: 'icon',
                  iconName: value.point.iconName || 'map-pin',
                })
              }
              label="Icon"
            />
          </div>

          {value.point.symbol === 'icon' ? (
            <>
              <IconPicker
                value={value.point.iconName}
                onChange={(iconName) => patch('point', { iconName })}
              />
              <div className="mt-3 space-y-3">
                <Slider
                  label="Icon size"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={value.point.iconSize ?? 1}
                  onChange={(n) => patch('point', { iconSize: n })}
                />
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={value.point.iconTint !== false}
                    onChange={(e) =>
                      patch('point', { iconTint: e.target.checked })
                    }
                    className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
                  />
                  <span className="text-ink-1">Tint with fill color</span>
                </label>
                {value.point.iconTint !== false ? (
                  <Color
                    label="Fill"
                    value={value.point.color}
                    onChange={(c) => patch('point', { color: c })}
                  />
                ) : null}
              </div>
              <p className="mt-2 text-2xs text-muted">
                Tinting renders the icon as a signed-distance field
                so the fill color applies cleanly at any size.
                Un-tick if you want the icon to stay in its shipped
                color.
              </p>

              {/* #146: background shape behind the icon. AGO /
                  Google-Maps "marker with icon" pattern. Defaults
                  to 'none' so existing layers don't change look. */}
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Background
                </p>
                <div className="space-y-3">
                  <label className="block text-xs">
                    <span className="text-muted">Shape</span>
                    <select
                      value={value.point.backgroundShape ?? 'none'}
                      onChange={(e) =>
                        patch('point', {
                          backgroundShape: e.target.value as
                            | 'none'
                            | 'circle'
                            | 'rounded-square',
                        })
                      }
                      className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                    >
                      <option value="none">None</option>
                      <option value="circle">Circle</option>
                      <option value="rounded-square">Rounded square</option>
                    </select>
                  </label>
                  {(value.point.backgroundShape ?? 'none') !== 'none' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Color
                        label="Fill"
                        value={value.point.backgroundFill ?? '#ffffff'}
                        onChange={(c) =>
                          patch('point', { backgroundFill: c })
                        }
                      />
                      <Color
                        label="Outline"
                        value={value.point.backgroundStrokeColor ?? '#111827'}
                        onChange={(c) =>
                          patch('point', { backgroundStrokeColor: c })
                        }
                      />
                      <Slider
                        label="Outline width"
                        min={0}
                        max={6}
                        step={0.5}
                        value={value.point.backgroundStrokeWidth ?? 1.5}
                        onChange={(n) =>
                          patch('point', { backgroundStrokeWidth: n })
                        }
                      />
                    </div>
                  ) : null}
                </div>
                {(value.point.backgroundShape ?? 'none') ===
                'rounded-square' ? (
                  <p className="mt-2 text-2xs text-muted">
                    Rounded square renders as a soft pill until the
                    sprite-bake renderer ships; appearance is close
                    but the corners read as fully circular.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Color
                label="Fill"
                value={value.point.color}
                onChange={(c) => patch('point', { color: c })}
              />
              <Slider
                label="Radius"
                min={2}
                max={24}
                step={1}
                value={value.point.radius}
                onChange={(n) => patch('point', { radius: n })}
              />
              <Color
                label="Outline"
                value={value.point.strokeColor}
                onChange={(c) => patch('point', { strokeColor: c })}
              />
              <Slider
                label="Outline width"
                min={0}
                max={6}
                step={0.5}
                value={value.point.strokeWidth}
                onChange={(n) => patch('point', { strokeWidth: n })}
              />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function SymbolBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Icon grid for the point symbol picker. Searchable across label +
 * category so users can type what they're looking for rather than
 * browse the whole library. Selecting an entry sets the layer's
 * iconName; an SVG preview renders each option at 24x24.
 */
/** One uploaded SVG icon row, as the picker consumes it. Same
 *  shape the api emits at /api/map-icons. */
interface UploadedIcon {
  id: string;
  storageKey: string;
  storageUrl: string;
  label: string;
}

function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [uploads, setUploads] = useState<UploadedIcon[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);

  // Load the org's uploaded icons on mount. We don't refetch on
  // every keystroke -- the list is small (capped at 200 server-
  // side) and only grows when the user uploads a new icon, in
  // which case we splice the new row in client-side.
  useEffect(() => {
    void (async () => {
      try {
        const resp = await fetch('/api/portal/map-icons');
        if (resp.ok) {
          const rows = (await resp.json()) as UploadedIcon[];
          setUploads(rows);
        }
      } catch {
        /* uploads section just stays empty */
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(MAP_ICONS).filter(([name, icon]) => {
      if (category !== 'all' && icon.category !== category) return false;
      if (!q) return true;
      return (
        name.includes(q) ||
        icon.label.toLowerCase().includes(q) ||
        icon.category.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  const filteredUploads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || category === 'all' || category === 'uploads') {
      return uploads.filter((u) =>
        q ? u.label.toLowerCase().includes(q) : true,
      );
    }
    // When the user picks a non-"uploads" category we hide the
    // uploaded section entirely, mirroring the per-category
    // filter on the bundled grid.
    return [];
  }, [uploads, query, category]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same name
    if (!file) return;
    setUploadingName(file.name);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const resp = await fetch('/api/portal/map-icons', {
        method: 'POST',
        body: fd,
      });
      if (!resp.ok) {
        const body = await resp.text();
        let msg = body;
        try {
          const j = JSON.parse(body) as { message?: string | string[] };
          msg = Array.isArray(j.message)
            ? j.message.join('; ')
            : j.message ?? body;
        } catch {
          /* not JSON; use raw */
        }
        throw new Error(msg || `HTTP ${resp.status}`);
      }
      const row = (await resp.json()) as UploadedIcon;
      setUploads((prev) => [row, ...prev]);
      // Select the just-uploaded icon so the user can see it
      // applied immediately. The renderer resolves the
      // `upload:<key>` form by URL lookup at map load.
      onChange(`upload:${row.storageKey}`);
    } catch (err) {
      setUploadError((err as Error).message || 'Upload failed');
    } finally {
      setUploadingName(null);
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-2 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons..."
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        >
          <option value="all">all</option>
          {MAP_ICON_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex h-7 cursor-pointer items-center rounded border border-border bg-surface-1 px-2 text-2xs hover:bg-surface-2">
          + SVG
          <input
            type="file"
            accept="image/svg+xml,.svg"
            onChange={handleUpload}
            className="sr-only"
            disabled={uploadingName !== null}
          />
        </label>
      </div>
      {uploadingName ? (
        <div className="mb-2 rounded border border-border bg-surface-0 px-2 py-1 text-2xs text-muted">
          Uploading {uploadingName}...
        </div>
      ) : null}
      {uploadError ? (
        <div className="mb-2 rounded border border-danger/30 bg-danger/5 px-2 py-1 text-2xs text-danger">
          {uploadError}
        </div>
      ) : null}
      {filteredUploads.length > 0 ? (
        <>
          <div className="mb-1 text-2xs uppercase tracking-wide text-muted">
            Your uploads
          </div>
          <div className="mb-2 grid grid-cols-6 gap-1">
            {filteredUploads.map((u) => {
              const refName = `upload:${u.storageKey}`;
              const active = refName === value;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onChange(refName)}
                  title={u.label}
                  className={`flex aspect-square items-center justify-center rounded border p-1 transition-colors ${
                    active
                      ? 'border-accent bg-accent/10 ring-2 ring-accent/30'
                      : 'border-border bg-surface-1 hover:bg-surface-2'
                  }`}
                >
                  <img
                    src={u.storageUrl}
                    alt={u.label}
                    className="h-full w-full object-contain"
                  />
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto">
        {filtered.map(([name, icon]) => {
          const svg = renderIconSvg(name) ?? '';
          const active = name === value;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onChange(name)}
              title={icon.label}
              className={`flex aspect-square items-center justify-center rounded border p-1 transition-colors ${
                active
                  ? 'border-accent bg-accent/10 ring-2 ring-accent/30'
                  : 'border-border bg-surface-1 hover:bg-surface-2'
              }`}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          );
        })}
        {filtered.length === 0 && filteredUploads.length === 0 ? (
          <div className="col-span-6 py-4 text-center text-2xs text-muted">
            No icons match.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Color picker + hex text input pair used throughout the
 * symbology UI.  Exported so the scale-class editor (and any
 * other per-layer styling surface) renders the same control as
 * the main StyleEditor section above it.  Reusing this component
 * keeps fill/stroke pickers visually consistent across the
 * layer panel; do not fork a parallel control for new sections.
 */
export function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-surface-1 p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      </div>
    </label>
  );
}

/**
 * Range slider with a label + live value readout.  Exported
 * alongside `Color` for the same reason: per-class opacity /
 * width controls in the scale-class editor should look and feel
 * identical to the main StyleEditor's sliders.
 */
export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-2xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-accent"
      />
    </label>
  );
}

/** Dropdown for a DashStyle preset (#73). Pairs with
 *  `DASH_STYLES` from shared-types so adding a new preset there
 *  shows up here automatically. */
function DashSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DashStyle;
  onChange: (d: DashStyle) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DashStyle)}
        className="h-7 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      >
        {DASH_STYLES.map((d) => (
          <option key={d} value={d}>
            {dashStyleLabel(d)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Dropdown for line-cap / line-join. Generic over both because
 *  the option list shape + render is identical (#73). */
function CapJoinSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o[0]!.toUpperCase() + o.slice(1)}
          </option>
        ))}
      </select>
    </label>
  );
}
