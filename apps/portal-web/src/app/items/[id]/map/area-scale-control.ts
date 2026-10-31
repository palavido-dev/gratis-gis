// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MapLibre control: a dynamic area square next to the distance
 * scale bar. Shows "1 ac" / "10 ha" / … at the current zoom so
 * viewers have an area frame of reference, not just a linear one.
 *
 * Click cycles the unit (acres → hectares → m² → km² → mi² → ft²).
 * Preference persists in localStorage (`gg-area-scale-unit`).
 */

import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

import {
  AREA_UNIT_LABELS,
  type AreaUnit,
} from '@/lib/measure';
import {
  areaUnitIsImperial,
  metersPerPixel,
  nextAreaScaleUnit,
  pickAreaScale,
  readStoredAreaScaleUnit,
  writeStoredAreaScaleUnit,
} from '@/lib/map-area-scale';

export type AreaScaleControlOptions = {
  /** Called whenever the unit changes (so the linear ScaleControl
   *  can stay in the same metric/imperial family). */
  onUnitChange?: (unit: AreaUnit) => void;
  /** Optional aria / title strings (i18n from the React host). */
  ariaLabel?: string;
  title?: string;
};

export class AreaScaleControl implements IControl {
  private _map: MapLibreMap | undefined;
  private _container: HTMLDivElement | undefined;
  private _square: HTMLDivElement | undefined;
  private _label: HTMLSpanElement | undefined;
  private _unit: AreaUnit;
  private readonly _opts: AreaScaleControlOptions;

  constructor(opts: AreaScaleControlOptions = {}) {
    this._opts = opts;
    this._unit = readStoredAreaScaleUnit();
  }

  getDefaultPosition(): 'bottom-left' {
    return 'bottom-left';
  }

  /** Current area unit (for hosts that sync the distance scale). */
  getUnit(): AreaUnit {
    return this._unit;
  }

  setUnit(unit: AreaUnit): void {
    if (this._unit === unit) return;
    this._unit = unit;
    writeStoredAreaScaleUnit(unit);
    this._opts.onUnitChange?.(unit);
    this._update();
  }

  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-area-scale';
    container.setAttribute('role', 'button');
    container.tabIndex = 0;
    container.setAttribute(
      'aria-label',
      this._opts.ariaLabel ?? 'Area reference at this scale',
    );
    this._refreshTitle(container);

    const square = document.createElement('div');
    square.className = 'maplibregl-ctrl-area-scale-square';
    square.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'maplibregl-ctrl-area-scale-label';

    container.appendChild(square);
    container.appendChild(label);
    container.addEventListener('click', this._onClick);
    container.addEventListener('keydown', this._onKeyDown);

    this._container = container;
    this._square = square;
    this._label = label;

    map.on('move', this._onMove);
    map.on('projectiontransition', this._onMove);
    this._opts.onUnitChange?.(this._unit);
    this._update();
    return container;
  }

  onRemove(): void {
    if (this._map) {
      this._map.off('move', this._onMove);
      this._map.off('projectiontransition', this._onMove);
    }
    this._container?.removeEventListener('click', this._onClick);
    this._container?.removeEventListener('keydown', this._onKeyDown);
    this._container?.remove();
    this._container = undefined;
    this._square = undefined;
    this._label = undefined;
    this._map = undefined;
  }

  private _onMove = (): void => {
    this._update();
  };

  private _onClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.setUnit(nextAreaScaleUnit(this._unit));
    if (this._container) this._refreshTitle(this._container);
  };

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.setUnit(nextAreaScaleUnit(this._unit));
    if (this._container) this._refreshTitle(this._container);
  };

  private _refreshTitle(el: HTMLElement): void {
    const unitName = AREA_UNIT_LABELS[this._unit];
    el.title =
      this._opts.title ??
      `Area at this scale (${unitName}). Click to change units.`;
  }

  private _update(): void {
    const map = this._map;
    const square = this._square;
    const label = this._label;
    const container = this._container;
    if (!map || !square || !label || !container) return;

    const center = map.getCenter();
    // Prefer a measured meters-per-pixel from unproject so pitch /
    // globe stay consistent with MapLibre's own ScaleControl. Fall
    // back to the closed-form mercator formula when unproject fails
    // (e.g. mid-projection transition).
    let mpp = measureMetersPerPixel(map);
    if (mpp == null) {
      mpp = metersPerPixel(center.lat, map.getZoom());
    }
    const pick = pickAreaScale(mpp, this._unit);
    if (!pick) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    const side = Math.round(pick.sidePx * 10) / 10;
    square.style.width = `${side}px`;
    square.style.height = `${side}px`;
    if (label.textContent !== pick.label) {
      label.textContent = pick.label;
    }
  }
}

/**
 * Meters per pixel at the map center, measured the same way
 * ScaleControl measures its bar (unproject a fixed pixel width).
 */
function measureMetersPerPixel(map: MapLibreMap): number | null {
  try {
    const canvas = map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 2 || height < 2) return null;
    const y = height / 2;
    const x = width / 2;
    const samplePx = 50;
    const left = map.unproject([x - samplePx, y]);
    const right = map.unproject([x + samplePx, y]);
    if (!left || !right) return null;
    const meters = left.distanceTo(right);
    if (!Number.isFinite(meters) || meters <= 0) return null;
    return meters / (samplePx * 2);
  } catch {
    return null;
  }
}

/** Helper for hosts syncing ScaleControl.setUnit. */
export function scaleUnitForAreaUnit(
  unit: AreaUnit,
): 'imperial' | 'metric' {
  return areaUnitIsImperial(unit) ? 'imperial' : 'metric';
}
