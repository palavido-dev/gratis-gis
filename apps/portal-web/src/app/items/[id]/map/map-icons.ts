/**
 * Default point-symbol icon registry. Each entry is a single lucide
 * SVG rendered as a 24x24 viewBox with `currentColor` strokes; the
 * canvas registration step rasterizes them to 48x48 PNGs so
 * MapLibre's symbol layer can consume them via `addImage()`.
 *
 * Icons are deliberately monochrome and paired with `stroke-based`
 * lucide originals: that way color tinting via a future SDF pass
 * can light up without touching the asset list. For now they render
 * in black-ish, which reads well on every basemap we ship.
 *
 * To add an icon, paste the inner markup of its lucide SVG (what
 * appears inside the `<svg>` element). Names should be kebab-case
 * and match lucide's naming so future upgrades auto-align.
 *
 * Licensing: lucide is ISC-licensed: bundling is fine. If you want
 * a richer library (Noun Project, Maki, etc.), upload custom SVGs
 * per-org once that flow ships.
 */

export interface MapIcon {
  label: string;
  category: string;
  /** Inner SVG markup (without the surrounding <svg> element). */
  body: string;
}

// All lucide icons share a 24x24 viewBox, 2px stroke, rounded caps.
export const MAP_ICONS: Record<string, MapIcon> = {
  // --- markers ---
  'map-pin': {
    label: 'Map pin',
    category: 'markers',
    body: `<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>`,
  },
  star: {
    label: 'Star',
    category: 'markers',
    body: `<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.123 2.123 0 0 0 1.597-1.16z"/>`,
  },
  flag: {
    label: 'Flag',
    category: 'markers',
    body: `<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>`,
  },
  heart: {
    label: 'Heart',
    category: 'markers',
    body: `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>`,
  },
  circle: {
    label: 'Circle',
    category: 'markers',
    body: `<circle cx="12" cy="12" r="10"/>`,
  },
  square: {
    label: 'Square',
    category: 'markers',
    body: `<rect width="18" height="18" x="3" y="3" rx="2"/>`,
  },
  triangle: {
    label: 'Triangle',
    category: 'markers',
    body: `<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14a2 2 0 0 0 1.73 3h16a2 2 0 0 0 1.73-3Z"/>`,
  },

  // --- buildings ---
  home: {
    label: 'Home',
    category: 'buildings',
    body: `<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  },
  building: {
    label: 'Building',
    category: 'buildings',
    body: `<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>`,
  },
  'building-2': {
    label: 'Office',
    category: 'buildings',
    body: `<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>`,
  },
  school: {
    label: 'School',
    category: 'buildings',
    body: `<path d="M14 22v-4a2 2 0 1 0-4 0v4"/><path d="m18 10 4 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8l4-2"/><path d="M18 5v17"/><path d="m4 6 7.106-3.553a2 2 0 0 1 1.788 0L20 6"/><path d="M6 5v17"/><circle cx="12" cy="9" r="2"/>`,
  },
  hospital: {
    label: 'Hospital',
    category: 'buildings',
    body: `<path d="M12 6v4"/><path d="M14 14h-4"/><path d="M14 18h-4"/><path d="M14 8h-4"/><path d="M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2"/><path d="M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18"/>`,
  },
  warehouse: {
    label: 'Warehouse',
    category: 'buildings',
    body: `<path d="M18 21V10.828a2 2 0 0 0-1.414-1.914l-6-1.8a2 2 0 0 0-1.172 0l-6 1.8A2 2 0 0 0 2 10.828V21"/><path d="M6 21v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9"/><path d="M6 15h11"/><path d="M6 19h11"/><path d="M22 21H2"/>`,
  },
  factory: {
    label: 'Factory',
    category: 'buildings',
    body: `<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/>`,
  },

  // --- places ---
  store: {
    label: 'Store',
    category: 'places',
    body: `<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>`,
  },
  'shopping-bag': {
    label: 'Shopping',
    category: 'places',
    body: `<path d="M16 10a4 4 0 0 1-8 0"/><path d="M3.103 6.034h17.794"/><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/>`,
  },
  utensils: {
    label: 'Restaurant',
    category: 'places',
    body: `<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>`,
  },
  coffee: {
    label: 'Coffee',
    category: 'places',
    body: `<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>`,
  },

  // --- nature ---
  'tree-pine': {
    label: 'Tree',
    category: 'nature',
    body: `<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>`,
  },
  flower: {
    label: 'Flower',
    category: 'nature',
    body: `<path d="M12 7.5a4.5 4.5 0 1 1 4.5 4.5M12 7.5A4.5 4.5 0 1 0 7.5 12M12 7.5V9m-4.5 3a4.5 4.5 0 1 0 4.5 4.5M7.5 12H9m7.5 0a4.5 4.5 0 1 1-4.5 4.5m4.5-4.5H15m-3 4.5V15"/><circle cx="12" cy="12" r="3"/><path d="m8 16 1.5-1.5"/><path d="M14.5 9.5 16 8"/><path d="m8 8 1.5 1.5"/><path d="M14.5 14.5 16 16"/>`,
  },
  droplets: {
    label: 'Water',
    category: 'nature',
    body: `<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>`,
  },
  mountain: {
    label: 'Mountain',
    category: 'nature',
    body: `<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>`,
  },

  // --- transport ---
  car: {
    label: 'Car',
    category: 'transport',
    body: `<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>`,
  },
  bus: {
    label: 'Bus',
    category: 'transport',
    body: `<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>`,
  },
  plane: {
    label: 'Plane',
    category: 'transport',
    body: `<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>`,
  },
  anchor: {
    label: 'Anchor',
    category: 'transport',
    body: `<path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/><circle cx="12" cy="5" r="3"/>`,
  },
};

export const MAP_ICON_NAMES = Object.keys(MAP_ICONS);
export const MAP_ICON_CATEGORIES = [
  ...new Set(Object.values(MAP_ICONS).map((i) => i.category)),
];

/**
 * MapLibre image id for a plain icon. Prefixed so the icons
 * namespace can't collide with anything the basemap style already
 * registers.
 */
export function iconImageId(name: string): string {
  return `gg-icon-${name}`;
}

/**
 * MapLibre image id for the SDF (tintable) copy of an icon. We
 * register both variants and let the renderer pick based on the
 * layer's `iconTint` setting.
 */
export function iconSdfImageId(name: string): string {
  return `gg-icon-${name}-sdf`;
}

/**
 * Render an icon as a full SVG document for plain rasterization.
 * Used when we want the icon to display in its ship color (no SDF,
 * no tinting). Lucide originals use stroke-based paths, so we keep
 * the stroke as the given color and leave fill as none.
 */
export function renderIconSvg(name: string, color = '#111827'): string | null {
  const icon = MAP_ICONS[name];
  if (!icon) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>`;
}

/**
 * Render an icon as a black-on-transparent SVG with a thicker stroke
 * so the resulting alpha mask has enough body for a good SDF. Used
 * only when preparing the distance-field copy of an icon that will
 * be tinted via MapLibre's `icon-color`.
 *
 * The trick here is that lucide icons are drawn with a 2 px stroke
 * at 24 px, which after rasterization to 96 px leaves tiny features
 * (like the center dot of a map-pin) smaller than the typical SDF
 * buffer. Bumping the stroke to 2.5 gives the distance transform
 * enough signal to produce a clean tint.
 */
export function renderIconSvgForSdf(name: string): string | null {
  const icon = MAP_ICONS[name];
  if (!icon) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>`;
}
