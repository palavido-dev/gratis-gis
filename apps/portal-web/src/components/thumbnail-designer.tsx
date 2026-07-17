// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Thumbnail designer (#66 + polish pass #73).  Replaces the previous
 * "Upload image" affordance on item edit with a four-layer composer
 * that matches the AGO ArcGISThumbnailBuilder Story Map template:
 *
 *   - Background: color OR full-bleed image, with image opacity
 *   - Sidebar (right side): color + opacity; rotated type label
 *   - Title bar (bottom): color + opacity; carries the item title
 *   - Logo (optional): small image, top-left corner
 *
 * The sidebar text and title text always render and follow the
 * item's name + type so a rename re-renders without a re-bake (per
 * the project memory: "sidebar + title overlays always render").
 *
 * Image uploads (background image + logo) go through ImageUploader's
 * presign-PUT-persist flow, same as the legacy thumbnail upload
 * path; the resulting URL lands in the design blob.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import {
  defaultThumbnailDesign,
  getItemTypeLabel,
  renderThumbnailSvg,
  type ItemType,
  type ThumbnailDesign,
} from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';

interface Props {
  /** Item type drives the type-default palette and the sidebar label. */
  type: ItemType;
  /** Live title piped into the preview so the author sees the
   *  current item name baked into the SVG as they type elsewhere
   *  on the form. */
  title: string;
  /** Current design (or null for "use type default"). */
  value: ThumbnailDesign | null | undefined;
  onChange: (next: ThumbnailDesign) => void;
}

export function ThumbnailDesigner({ type, title, value, onChange }: Props) {
  const design = useMemo<ThumbnailDesign>(
    () => value ?? defaultThumbnailDesign(type),
    [value, type],
  );

  const svg = useMemo(
    () =>
      renderThumbnailSvg({
        title: title || '(Untitled)',
        typeLabel: getItemTypeLabel(type),
        design,
      }),
    [title, type, design],
  );

  function patch(p: Partial<ThumbnailDesign>): void {
    onChange({ ...design, ...p });
  }

  function reset(): void {
    onChange(defaultThumbnailDesign(type));
  }

  // Fall-back values for the new fields so a design that predates
  // the polish pass still renders something coherent in the sliders.
  const sidebarOpacity = design.sidebarOpacity ?? 0.95;
  const titleBarColor = design.titleBar ?? design.sidebar;
  const titleBarOpacity = design.titleBarOpacity ?? 0.8;
  const backgroundOpacity = design.backgroundOpacity ?? 1;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,_360px)_minmax(0,_1fr)]">
      {/* Live preview pane */}
      <div className="flex flex-col gap-2">
        <div
          className="aspect-[3/2] w-full overflow-hidden rounded-md border border-border bg-surface-2"
          aria-label="Thumbnail preview"
          /* eslint-disable-next-line react/no-danger */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="flex items-center justify-between">
          <p className="text-2xs text-muted">
            Title and type label follow the item name and type. A
            rename refreshes the thumbnail with no re-bake.
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
            title="Reset every layer to the type default palette"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>

      {/* Layer controls */}
      <div className="space-y-4">
        <LayerSection title="Background" hint="Color or image behind everything.">
          <ColorRow
            label="Color"
            value={design.background}
            onChange={(v) => patch({ background: v })}
          />
          <ImageRow
            label="Image"
            hint="Optional. Renders above the color, with the opacity slider below."
            value={design.backgroundImage ?? null}
            onChange={(v) => patch({ backgroundImage: v })}
          />
          {design.backgroundImage ? (
            <OpacityRow
              label="Image opacity"
              value={backgroundOpacity}
              onChange={(v) => patch({ backgroundOpacity: v })}
            />
          ) : null}
        </LayerSection>

        <LayerSection
          title="Sidebar"
          hint="Right-side strip carrying the type label."
        >
          <ColorRow
            label="Color"
            value={design.sidebar}
            onChange={(v) => patch({ sidebar: v })}
          />
          <OpacityRow
            label="Opacity"
            value={sidebarOpacity}
            onChange={(v) => patch({ sidebarOpacity: v })}
          />
        </LayerSection>

        <LayerSection
          title="Title bar"
          hint="Strip across the bottom behind the item title."
        >
          <ColorRow
            label="Color"
            value={titleBarColor}
            onChange={(v) => patch({ titleBar: v })}
          />
          <OpacityRow
            label="Opacity"
            value={titleBarOpacity}
            onChange={(v) => patch({ titleBarOpacity: v })}
          />
        </LayerSection>

        <LayerSection title="Logo" hint="Optional badge in the top-left corner.">
          <ImageRow
            label="Image"
            hint="PNG with transparency reads best. Square images recommended."
            value={design.logo ?? null}
            onChange={(v) => patch({ logo: v })}
          />
        </LayerSection>
      </div>
    </div>
  );
}

function LayerSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  // #87b feedback -- closed by default.  The four sections combined
  // were ~600px tall and pushed the actual item fields (Title,
  // Description, Tags, Visibility, etc) way down the page.  Authors
  // who want to customize the thumbnail can click open the section
  // they care about; the live preview at the top of the designer
  // already shows what the current design produces, so a fully
  // collapsed designer is still informative.
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-surface-2"
        aria-expanded={open}
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-0">
            {title}
          </p>
          <p className="text-2xs text-muted">{hint}</p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${
            open ? '' : '-rotate-90'
          }`}
        />
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3">{children}</div>
      ) : null}
    </section>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <span
        className="relative inline-block h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border"
        style={{ background: value }}
        aria-hidden
      >
        <input
          type="color"
          value={normalizeForPicker(value)}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={label}
        />
      </span>
      <span className="min-w-0 flex-1 text-xs font-medium text-ink-1">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-24 rounded border border-border bg-surface-1 px-2 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    </label>
  );
}

function OpacityRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="flex items-center gap-3">
      <span className="min-w-0 flex-1 text-xs font-medium text-ink-1">
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-2 w-40 cursor-pointer accent-accent"
      />
      <span className="w-10 shrink-0 text-right font-mono text-2xs text-muted">
        {pct}%
      </span>
    </label>
  );
}

function ImageRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-ink-1">{label}</p>
      <ImageUploader
        kind="item-thumb"
        value={value}
        onChange={onChange}
        seed={label}
        label={label}
        size="md"
        rounded="md"
        hint={hint}
      />
    </div>
  );
}

/**
 * Coerce arbitrary CSS color values (rgb(), hsl(), named colors) to
 * a #rrggbb form the native color input accepts.  Anything we don't
 * recognize falls back to a neutral gray; the visible swatch above
 * still renders the original value, so the author sees what's
 * actually saved even if the picker can't open against it.
 */
function normalizeForPicker(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return '#888888';
}
