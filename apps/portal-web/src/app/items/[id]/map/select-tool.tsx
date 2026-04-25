'use client';

import {
  Hand,
  MousePointer2,
  Pentagon,
  Spline,
  Square,
  X,
} from 'lucide-react';

export type SelectToolMode =
  | 'off'
  | 'click'
  | 'rectangle'
  | 'polygon'
  | 'lasso';

interface Props {
  mode: SelectToolMode;
  onChange: (next: SelectToolMode) => void;
  /** How many features are currently selected across all layers. */
  selectedCount: number;
  onClearSelection: () => void;
}

/**
 * Floating toolbar for map-side feature selection. Sits just below
 * the search bar in the top-left of the map canvas so authors can
 * reach it without covering features.
 *
 * Modes:
 *   - off: normal pan/zoom, click shows popup (today's default).
 *   - click: clicks pick a single feature into the selection.
 *     Shift replaces with the click target added in; Ctrl/Cmd
 *     toggles the target in/out.
 *   - rectangle: drag a box; every feature whose drawn geometry
 *     overlaps the box becomes the selection (Shift adds).
 *   - polygon: click to add vertices, click the first vertex (or
 *     press Enter) to close. Features whose bbox centroid falls
 *     inside the polygon are selected.
 *   - lasso: freehand drag; release to close. Same centroid test
 *     as polygon once the path is formed.
 *
 * The toolbar owns no selection state: it just tells the canvas
 * which mode is live. The canvas applies selection changes via a
 * setSelection callback so the attribute table + feature-state
 * highlight stay in lockstep.
 */
export function SelectToolbar({
  mode,
  onChange,
  selectedCount,
  onClearSelection,
}: Props) {
  return (
    <div className="absolute left-4 top-[3.75rem] z-10 flex items-center gap-1 rounded-lg border border-border bg-surface-1/95 p-1 shadow-raised backdrop-blur">
      <ToolButton
        icon={Hand}
        label="Pan"
        active={mode === 'off'}
        onClick={() => onChange('off')}
      />
      <div className="mx-1 h-5 w-px bg-border" />
      <ToolButton
        icon={MousePointer2}
        label="Click select"
        active={mode === 'click'}
        onClick={() => onChange(mode === 'click' ? 'off' : 'click')}
        accent
      />
      <ToolButton
        icon={Square}
        label="Rectangle select"
        active={mode === 'rectangle'}
        onClick={() => onChange(mode === 'rectangle' ? 'off' : 'rectangle')}
        accent
      />
      <ToolButton
        icon={Pentagon}
        label="Polygon select"
        active={mode === 'polygon'}
        onClick={() => onChange(mode === 'polygon' ? 'off' : 'polygon')}
        accent
      />
      <ToolButton
        icon={Spline}
        label="Freehand select"
        active={mode === 'lasso'}
        onClick={() => onChange(mode === 'lasso' ? 'off' : 'lasso')}
        accent
      />
      {selectedCount > 0 ? (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <button
            type="button"
            onClick={onClearSelection}
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-0"
            title="Clear selection"
          >
            <X className="h-3 w-3" />
            <span className="tabular-nums">{selectedCount}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
  accent = false,
}: {
  icon: typeof MousePointer2;
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
        active
          ? accent
            ? 'bg-accent text-accent-foreground'
            : 'bg-surface-2 text-ink-0 ring-1 ring-border'
          : 'text-muted hover:bg-surface-2 hover:text-ink-0'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
