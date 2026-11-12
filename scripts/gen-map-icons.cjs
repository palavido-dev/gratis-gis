// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generator for `apps/portal-web/src/app/items/[id]/map/map-icons.ts`.
 *
 * Reads lucide-react's per-icon ESM source files, extracts the
 * iconNode array, and emits a single TS module that the picker
 * + renderer consume. Curated set: ~150 icons across the
 * categories common to GIS map symbology (Public Safety,
 * Transportation, Buildings, Nature, Utilities, etc.). The
 * lucide-react package itself is already a runtime dep for UI
 * chrome; this script just lifts the iconNode data out into a
 * static module so we don't pull all 1,700+ icons into every
 * page that touches a map.
 *
 * Run once after upgrading lucide-react:
 *
 *   node scripts/gen-map-icons.cjs
 *
 * Output: apps/portal-web/src/app/items/[id]/map/map-icons.ts
 * (overwrites; review the diff before committing).
 */

const fs = require('node:fs');
const path = require('node:path');

const LUCIDE_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  '.pnpm',
);
const pnpmRoot = fs
  .readdirSync(LUCIDE_DIR)
  .find((d) => d.startsWith('lucide-react@'));
if (!pnpmRoot) {
  console.error('lucide-react not found in node_modules/.pnpm');
  process.exit(1);
}
const ICON_DIR = path.join(
  LUCIDE_DIR,
  pnpmRoot,
  'node_modules',
  'lucide-react',
  'dist',
  'esm',
  'icons',
);

/**
 * Curated icon list. Keys are lucide kebab-case names (matching
 * the .js filenames). Each value is { label, category }.
 *
 * To add an icon: pick its name from https://lucide.dev/icons,
 * add it here under a sensible category. Categories themselves
 * are stable (used as picker filters) -- prefer adding to an
 * existing category over inventing a new one.
 */
const ICONS = {
  // --- markers (basic shape primitives, work with any tint) ---
  'map-pin': { label: 'Map pin', category: 'markers' },
  star: { label: 'Star', category: 'markers' },
  flag: { label: 'Flag', category: 'markers' },
  heart: { label: 'Heart', category: 'markers' },
  circle: { label: 'Circle', category: 'markers' },
  square: { label: 'Square', category: 'markers' },
  triangle: { label: 'Triangle', category: 'markers' },
  hexagon: { label: 'Hexagon', category: 'markers' },
  octagon: { label: 'Octagon', category: 'markers' },
  pentagon: { label: 'Pentagon', category: 'markers' },
  diamond: { label: 'Diamond', category: 'markers' },
  crosshair: { label: 'Crosshair', category: 'markers' },
  target: { label: 'Target', category: 'markers' },
  bookmark: { label: 'Bookmark', category: 'markers' },
  award: { label: 'Award', category: 'markers' },

  // --- buildings ---
  home: { label: 'Home', category: 'buildings' },
  building: { label: 'Building', category: 'buildings' },
  'building-2': { label: 'Office', category: 'buildings' },
  hospital: { label: 'Hospital', category: 'buildings' },
  school: { label: 'School', category: 'buildings' },
  university: { label: 'University', category: 'buildings' },
  warehouse: { label: 'Warehouse', category: 'buildings' },
  factory: { label: 'Factory', category: 'buildings' },
  church: { label: 'Church', category: 'buildings' },
  store: { label: 'Store', category: 'buildings' },
  hotel: { label: 'Hotel', category: 'buildings' },
  landmark: { label: 'Landmark', category: 'buildings' },
  castle: { label: 'Castle', category: 'buildings' },
  tent: { label: 'Tent', category: 'buildings' },

  // --- public safety / government ---
  shield: { label: 'Shield', category: 'public-safety' },
  'shield-check': { label: 'Shield (check)', category: 'public-safety' },
  'shield-alert': { label: 'Shield (alert)', category: 'public-safety' },
  badge: { label: 'Badge', category: 'public-safety' },
  siren: { label: 'Siren', category: 'public-safety' },
  'alert-triangle': { label: 'Alert (triangle)', category: 'public-safety' },
  'alert-octagon': { label: 'Alert (octagon)', category: 'public-safety' },
  'alert-circle': { label: 'Alert (circle)', category: 'public-safety' },
  ban: { label: 'Prohibited', category: 'public-safety' },
  scale: { label: 'Scales of justice', category: 'public-safety' },
  gavel: { label: 'Gavel', category: 'public-safety' },
  vote: { label: 'Vote', category: 'public-safety' },

  // --- transportation ---
  car: { label: 'Car', category: 'transportation' },
  truck: { label: 'Truck', category: 'transportation' },
  bus: { label: 'Bus', category: 'transportation' },
  'train-front': { label: 'Train', category: 'transportation' },
  'train-track': { label: 'Train track', category: 'transportation' },
  plane: { label: 'Plane', category: 'transportation' },
  ship: { label: 'Ship', category: 'transportation' },
  bike: { label: 'Bike', category: 'transportation' },
  'tram-front': { label: 'Tram', category: 'transportation' },
  caravan: { label: 'Caravan', category: 'transportation' },
  navigation: { label: 'Navigation', category: 'transportation' },
  route: { label: 'Route', category: 'transportation' },
  anchor: { label: 'Anchor', category: 'transportation' },
  'square-parking': { label: 'Parking', category: 'transportation' },
  'traffic-cone': { label: 'Traffic cone', category: 'transportation' },

  // --- nature ---
  'tree-deciduous': { label: 'Tree', category: 'nature' },
  'tree-pine': { label: 'Pine tree', category: 'nature' },
  trees: { label: 'Forest', category: 'nature' },
  mountain: { label: 'Mountain', category: 'nature' },
  'mountain-snow': { label: 'Snowy mountain', category: 'nature' },
  waves: { label: 'Waves', category: 'nature' },
  droplet: { label: 'Droplet', category: 'nature' },
  cloud: { label: 'Cloud', category: 'nature' },
  'cloud-rain': { label: 'Rain', category: 'nature' },
  'cloud-snow': { label: 'Snow', category: 'nature' },
  snowflake: { label: 'Snowflake', category: 'nature' },
  sun: { label: 'Sun', category: 'nature' },
  moon: { label: 'Moon', category: 'nature' },
  wind: { label: 'Wind', category: 'nature' },
  flame: { label: 'Flame', category: 'nature' },
  leaf: { label: 'Leaf', category: 'nature' },
  sprout: { label: 'Sprout', category: 'nature' },
  flower: { label: 'Flower', category: 'nature' },
  bug: { label: 'Bug', category: 'nature' },
  fish: { label: 'Fish', category: 'nature' },
  bird: { label: 'Bird', category: 'nature' },
  rabbit: { label: 'Rabbit', category: 'nature' },

  // --- utilities ---
  power: { label: 'Power', category: 'utilities' },
  fuel: { label: 'Fuel', category: 'utilities' },
  'plug-zap': { label: 'Plug', category: 'utilities' },
  zap: { label: 'Lightning', category: 'utilities' },
  lightbulb: { label: 'Lightbulb', category: 'utilities' },
  antenna: { label: 'Antenna', category: 'utilities' },
  wifi: { label: 'Wi-Fi', category: 'utilities' },
  signal: { label: 'Signal', category: 'utilities' },
  radio: { label: 'Radio', category: 'utilities' },
  'satellite-dish': { label: 'Satellite dish', category: 'utilities' },
  satellite: { label: 'Satellite', category: 'utilities' },
  battery: { label: 'Battery', category: 'utilities' },
  recycle: { label: 'Recycle', category: 'utilities' },
  trash: { label: 'Trash', category: 'utilities' },
  pipette: { label: 'Pipette', category: 'utilities' },

  // --- services / amenities ---
  coffee: { label: 'Coffee', category: 'services' },
  utensils: { label: 'Restaurant', category: 'services' },
  'shopping-cart': { label: 'Shopping cart', category: 'services' },
  'shopping-bag': { label: 'Shopping bag', category: 'services' },
  bed: { label: 'Bed', category: 'services' },
  baby: { label: 'Baby', category: 'services' },
  ticket: { label: 'Ticket', category: 'services' },
  music: { label: 'Music', category: 'services' },
  film: { label: 'Film', category: 'services' },
  popcorn: { label: 'Popcorn', category: 'services' },
  'ferris-wheel': { label: 'Amusement', category: 'services' },
  dumbbell: { label: 'Gym', category: 'services' },
  scissors: { label: 'Salon', category: 'services' },
  stethoscope: { label: 'Medical', category: 'services' },
  pill: { label: 'Pharmacy', category: 'services' },
  syringe: { label: 'Vaccine', category: 'services' },

  // --- communication / info ---
  phone: { label: 'Phone', category: 'communication' },
  'phone-call': { label: 'Call', category: 'communication' },
  'message-circle': { label: 'Message', category: 'communication' },
  mail: { label: 'Mail', category: 'communication' },
  megaphone: { label: 'Megaphone', category: 'communication' },
  info: { label: 'Info', category: 'communication' },
  'help-circle': { label: 'Help', category: 'communication' },
  globe: { label: 'Globe', category: 'communication' },

  // --- people ---
  user: { label: 'User', category: 'people' },
  users: { label: 'Group', category: 'people' },
  accessibility: { label: 'Accessibility', category: 'people' },
  dog: { label: 'Dog', category: 'people' },
  cat: { label: 'Cat', category: 'people' },

  // --- science / education ---
  microscope: { label: 'Microscope', category: 'science' },
  'flask-conical': { label: 'Flask', category: 'science' },
  'flask-round': { label: 'Beaker', category: 'science' },
  atom: { label: 'Atom', category: 'science' },
  telescope: { label: 'Telescope', category: 'science' },
  'book-open': { label: 'Book', category: 'science' },
  'graduation-cap': { label: 'Graduation', category: 'science' },

  // --- tools / objects ---
  camera: { label: 'Camera', category: 'tools' },
  video: { label: 'Video', category: 'tools' },
  'hard-hat': { label: 'Construction', category: 'tools' },
  hammer: { label: 'Hammer', category: 'tools' },
  wrench: { label: 'Wrench', category: 'tools' },
  drill: { label: 'Drill', category: 'tools' },
  'paint-bucket': { label: 'Paint', category: 'tools' },
  palette: { label: 'Palette', category: 'tools' },
  package: { label: 'Package', category: 'tools' },
  'tractor': { label: 'Tractor', category: 'tools' },

  // --- status / annotation ---
  check: { label: 'Check', category: 'status' },
  x: { label: 'X', category: 'status' },
  'check-circle': { label: 'Check (circle)', category: 'status' },
  'x-circle': { label: 'X (circle)', category: 'status' },
  clock: { label: 'Clock', category: 'status' },
  timer: { label: 'Timer', category: 'status' },
  calendar: { label: 'Calendar', category: 'status' },
  lock: { label: 'Lock', category: 'status' },
  unlock: { label: 'Unlock', category: 'status' },
  key: { label: 'Key', category: 'status' },
  eye: { label: 'Eye', category: 'status' },
  'eye-off': { label: 'Hidden', category: 'status' },

  // --- UI / UX (actions and controls for tool buttons) ---
  // Generic interactive glyphs the map-symbology picker won't
  // typically use, but the App Designer Tool widget icon picker
  // relies on so authors don't have to settle for a map pin.
  save: { label: 'Save', category: 'ui' },
  pencil: { label: 'Edit', category: 'ui' },
  'pencil-line': { label: 'Edit (line)', category: 'ui' },
  'trash-2': { label: 'Delete', category: 'ui' },
  copy: { label: 'Copy', category: 'ui' },
  'clipboard-copy': { label: 'Clipboard', category: 'ui' },
  'clipboard-paste': { label: 'Paste', category: 'ui' },
  plus: { label: 'Add', category: 'ui' },
  minus: { label: 'Remove', category: 'ui' },
  download: { label: 'Download', category: 'ui' },
  upload: { label: 'Upload', category: 'ui' },
  printer: { label: 'Print', category: 'ui' },
  'share-2': { label: 'Share', category: 'ui' },
  send: { label: 'Send', category: 'ui' },
  'refresh-cw': { label: 'Refresh', category: 'ui' },
  'rotate-cw': { label: 'Rotate', category: 'ui' },
  'undo-2': { label: 'Undo', category: 'ui' },
  'redo-2': { label: 'Redo', category: 'ui' },
  search: { label: 'Search', category: 'ui' },
  filter: { label: 'Filter', category: 'ui' },
  'filter-x': { label: 'Clear filter', category: 'ui' },
  'list-filter': { label: 'Filter list', category: 'ui' },
  'sliders-horizontal': { label: 'Sliders', category: 'ui' },
  'arrow-down-az': { label: 'Sort A-Z', category: 'ui' },
  'arrow-up-az': { label: 'Sort Z-A', category: 'ui' },
  'arrow-down-up': { label: 'Sort', category: 'ui' },
  database: { label: 'Query', category: 'ui' },
  'database-zap': { label: 'Run query', category: 'ui' },
  'file-search': { label: 'Find', category: 'ui' },
  settings: { label: 'Settings', category: 'ui' },
  'settings-2': { label: 'Settings (alt)', category: 'ui' },
  cog: { label: 'Gear', category: 'ui' },
  menu: { label: 'Menu', category: 'ui' },
  'more-horizontal': { label: 'More', category: 'ui' },
  'more-vertical': { label: 'More (vertical)', category: 'ui' },
  link: { label: 'Link', category: 'ui' },
  paperclip: { label: 'Attach', category: 'ui' },
  pin: { label: 'Pin', category: 'ui' },
  tag: { label: 'Tag', category: 'ui' },
  bell: { label: 'Notify', category: 'ui' },
  'arrow-right': { label: 'Next', category: 'ui' },
  'arrow-left': { label: 'Back', category: 'ui' },
  'arrow-up': { label: 'Up', category: 'ui' },
  'arrow-down': { label: 'Down', category: 'ui' },
  play: { label: 'Play', category: 'ui' },
  pause: { label: 'Pause', category: 'ui' },
  'circle-stop': { label: 'Stop', category: 'ui' },
  'rotate-ccw': { label: 'Reset', category: 'ui' },
  // `square` and `star` are already in 'markers' and can be picked
  // there; not re-listed here because plain-object keys collapse to
  // a single entry, which would steal them out of 'markers'.
};

const CATEGORY_ORDER = [
  'ui',
  'markers',
  'buildings',
  'public-safety',
  'transportation',
  'nature',
  'utilities',
  'services',
  'communication',
  'people',
  'science',
  'tools',
  'status',
];

/** Read a lucide-react icon source file, following alias
 *  re-exports of the form `export { default } from './foo.mjs'`
 *  (lucide deprecates + re-aliases icon names frequently).
 *  lucide-react 1.x ships `.mjs`; older releases shipped `.js`. */
function readIconSource(name) {
  const p = ['mjs', 'js']
    .map((ext) => path.join(ICON_DIR, `${name}.${ext}`))
    .find((f) => fs.existsSync(f));
  if (!p) return null;
  const src = fs.readFileSync(p, 'utf8');
  const alias = src.match(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\/(.+?)\.m?js['"]/);
  if (alias) return readIconSource(alias[1]);
  return src;
}

/** Pull the iconNode array out of a lucide-react .js file. The
 *  source looks like:
 *
 *    const Foo = createLucideIcon("Foo", [
 *      ["path", { d: "...", key: "..." }],
 *      ...
 *    ]);
 *
 *  We grab everything inside the createLucideIcon array. */
function extractIconNode(src) {
  // lucide-react 1.x: `const __iconData = { name, size, node: [...] };`
  // Older: `createLucideIcon("Name", [...]);`
  const data = src.match(/__iconData\s*=\s*(\{[\s\S]*?\n\});/);
  if (data) {
    // eslint-disable-next-line no-eval
    const obj = eval(`(${data[1]})`);
    return Array.isArray(obj && obj.node) ? obj.node : null;
  }
  const m = src.match(/createLucideIcon\([^,]+,\s*(\[[\s\S]*?\])\s*\)\s*;/);
  if (!m) return null;
  // The array uses bare object keys; JSON.parse can't handle that
  // but eval can. The lucide files we read are part of our own
  // node_modules at build time, not user input, so eval is fine
  // here -- this script runs once on a fresh install, never at
  // runtime.
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

/** Render an iconNode tuple `[tag, attrs, children?]` as an
 *  inline SVG body string. Drops `key` (React-only) but keeps
 *  every other attr so the visual matches lucide.dev exactly. */
function iconNodeToBody(node) {
  return node
    .map(([tag, attrs, children]) => {
      const a = Object.entries(attrs || {})
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      if (Array.isArray(children) && children.length > 0) {
        return `<${tag} ${a}>${children
          .map((c) => iconNodeToBody([c]))
          .join('')}</${tag}>`;
      }
      return `<${tag} ${a}/>`;
    })
    .join('');
}

const out = [];
out.push('// SPDX-License-Identifier: AGPL-3.0-or-later');
out.push('// ------------------------------------------------------------------');
out.push('// GENERATED FILE -- do not edit by hand.');
out.push('// Regenerate with: node scripts/gen-map-icons.cjs');
out.push('// Source: lucide-react icon SVG nodes, ISC-licensed.');
out.push('// ------------------------------------------------------------------');
out.push('');
out.push("import { safeCssColor } from '@gratis-gis/shared-types';");
out.push('');
out.push('/**');
out.push(' * Map point-symbol icon registry (#73). Each entry is a');
out.push(' * lucide-react glyph extracted to its raw SVG body. The picker');
out.push(' * grid + the MapLibre image-registration step both consume this');
out.push(' * registry; adding an icon means running gen-map-icons.cjs');
out.push(' * with a fresh entry in the script\'s ICONS map.');
out.push(' *');
out.push(' * Icons share lucide\'s 24x24 viewBox, 2px stroke, rounded caps');
out.push(' * conventions. The canvas rasterizer scales them to 48x48 PNG');
out.push(' * when registering with MapLibre.');
out.push(' */');
out.push('');
out.push('export interface MapIcon {');
out.push('  label: string;');
out.push('  category: string;');
out.push('  /** Inner SVG markup (without the surrounding <svg> element). */');
out.push('  body: string;');
out.push('}');
out.push('');
out.push('export const MAP_ICONS: Record<string, MapIcon> = {');

let missing = 0;
const categorized = {};
for (const [name, meta] of Object.entries(ICONS)) {
  // Try multiple filename variants for lucide. Some entries
  // map to a different on-disk name (icon aliases) which
  // readIconSource transparently follows via the
  // `export { default } from './other.js'` re-export chain.
  const candidates = [name, name.replace(/_/g, '-')];
  let src = null;
  for (const cand of candidates) {
    src = readIconSource(cand);
    if (src) break;
  }
  if (!src) {
    console.error(`MISSING: ${name} (not found on disk)`);
    missing += 1;
    continue;
  }
  const node = extractIconNode(src);
  if (!node) {
    console.error(`PARSE FAIL: ${name}`);
    missing += 1;
    continue;
  }
  const body = iconNodeToBody(node);
  out.push(`  ${JSON.stringify(name)}: {`);
  out.push(`    label: ${JSON.stringify(meta.label)},`);
  out.push(`    category: ${JSON.stringify(meta.category)},`);
  out.push(`    body: ${JSON.stringify(body)},`);
  out.push('  },');
  categorized[meta.category] = (categorized[meta.category] || 0) + 1;
}
out.push('};');
out.push('');
out.push('/** Ordered list of categories, for the picker\'s category select. */');
out.push(`export const MAP_ICON_CATEGORIES = ${JSON.stringify(CATEGORY_ORDER)} as const;`);
out.push('');
out.push('/** Inline SVG element wrapping an entry\'s body. Used by the');
out.push(' *  icon-picker grid + by the canvas rasterizer for MapLibre');
out.push(' *  image registration. Sized at the lucide-native 24x24 so');
out.push(' *  strokes hit pixel boundaries; the consumer applies its own');
out.push(' *  scaling. */');
out.push('export function renderIconSvg(');
out.push('  name: string,');
out.push('  opts: { stroke?: string; strokeWidth?: number } = {},');
out.push('): string | null {');
out.push('  const icon = MAP_ICONS[name];');
out.push('  if (!icon) return null;');
out.push('  // Both values are interpolated into markup that callers set with');
out.push('  // innerHTML, and the stroke comes from map style data an author');
out.push('  // controls. Only a value that cannot leave the attribute gets in.');
out.push('  const stroke = safeCssColor(opts.stroke, \'currentColor\');');
out.push('  const width = Number(opts.strokeWidth ?? 2);');
out.push('  const w = Number.isFinite(width) ? width : 2;');
out.push('  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +');
out.push('    `fill="none" stroke="${stroke}" stroke-width="${w}" ` +');
out.push('    `stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>`;');
out.push('}');
out.push('');
out.push('/**');
out.push(' * Variant of renderIconSvg used for the SDF rasterization');
out.push(' * pass. The SDF image must be a single-channel alpha mask in');
out.push(' * pure black; MapLibre\'s SDF renderer tints it at draw time');
out.push(' * via `icon-color`. Differs from renderIconSvg only in stroke');
out.push(' * color (#000) -- everything else lines up.');
out.push(' */');
out.push('export function renderIconSvgForSdf(name: string): string | null {');
out.push('  return renderIconSvg(name, { stroke: \'#000\' });');
out.push('}');
out.push('');
out.push('/** Stable MapLibre image ID for an icon\'s plain raster');
out.push(' *  variant (renders in its shipped color). */');
out.push('export function iconImageId(name: string): string {');
out.push('  return `gg:icon:${name}`;');
out.push('}');
out.push('');
out.push('/** Stable MapLibre image ID for an icon\'s SDF variant');
out.push(' *  (tintable via the layer\'s icon-color paint property). */');
out.push('export function iconSdfImageId(name: string): string {');
out.push('  return `gg:icon-sdf:${name}`;');
out.push('}');
out.push('');

const outFile = path.join(
  __dirname,
  '..',
  'apps',
  'portal-web',
  'src',
  'app',
  'items',
  '[id]',
  'map',
  'map-icons.ts',
);
if (missing > 0) {
  // Writing a partial registry would silently drop map symbols and
  // tool icons. Leave the committed file alone and fail loudly.
  console.error(`${missing} icon(s) missing; ${outFile} was not written.`);
  process.exit(1);
}
fs.writeFileSync(outFile, out.join('\n'));
console.log(
  `wrote ${outFile} (${
    Object.keys(ICONS).length - missing
  } icons, ${missing} missing)`,
);
console.log('by category:', categorized);
