// SPDX-License-Identifier: AGPL-3.0-or-later
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { BadRequestException } from '@nestjs/common';

/**
 * Extensions the product already accepts. The stored extension is one
 * of these constants (or `.bin`). The stored stem is the request's
 * file stem with every character outside `[A-Za-z0-9_.-]` replaced,
 * so GDAL still names a GeoJSON or CSV layer after the file the user
 * picked. A stored name never holds a path separator and never starts
 * with a dot, so it cannot leave the directory it is joined onto.
 */
const PAYLOAD_EXTENSIONS = [
  '.csv',
  '.tsv',
  '.txt',
  '.geojson',
  '.json',
  '.geojsonl',
  '.ndjson',
  '.parquet',
  '.geoparquet',
  '.kml',
  '.kmz',
  '.gml',
  '.gpx',
  '.gpkg',
  '.sqlite',
  '.zip',
  '.gdb',
  '.shp',
  '.dbf',
  '.shx',
  '.prj',
  '.cpg',
  '.fgb',
  '.dxf',
  '.tif',
  '.tiff',
  '.geotiff',
  '.cog',
  '.jp2',
  '.pmtiles',
  '.mbtiles',
  '.xlsx',
  '.xls',
] as const;

const pins = new WeakMap<object, { directory: string; filePath: string }>();

/** Longest stem kept from the request's file name. */
const STEM_MAX = 100;

/**
 * Stem of a stored upload name. Close to the old `safeFilename` rule
 * (anything outside `[A-Za-z0-9_.-]` becomes `_`, and so do leading,
 * trailing, and repeated dots) so a layer keeps the name it had
 * before uploads went to disk.
 * Returns `payload` when nothing usable is left.
 */
function storedStem(stem: string): string {
  const chars: string[] = [];
  for (let i = 0; i < stem.length && chars.length < STEM_MAX; i += 1) {
    const ch = stem.charAt(i);
    const ok =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '-' ||
      (ch === '.' && chars.length > 0 && chars[chars.length - 1] !== '.');
    chars.push(ok ? ch : '_');
  }
  // A trailing dot would put `..` in front of the extension.
  const out = chars.join('').replace(/\.$/, '_');
  return /^[_]*$/.test(out) ? 'payload' : out;
}

/**
 * Name multer may write: `<stem><ext>`. `..`, absolute paths, and
 * names without a known extension become `payload.bin`. The extension
 * is copied from the list above, not from the request string.
 */
export function serverUploadName(originalName: string): string {
  const base = basename(typeof originalName === 'string' ? originalName : '');
  const dot = base.lastIndexOf('.');
  const ext = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  for (const allowed of PAYLOAD_EXTENSIONS) {
    if (ext === allowed) return `${storedStem(base.slice(0, dot))}${allowed}`;
  }
  return 'payload.bin';
}

/**
 * The stored name, or null when `name` is not one this process would
 * have chosen. A name is accepted only when `serverUploadName` maps it
 * to itself, which rules out separators, `..`, and leading dots.
 */
export function payloadFileName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
  const stored = serverUploadName(name);
  return stored === name ? stored : null;
}

/**
 * Remember the directory this process just created for `req`. The
 * file name is attached by `attachDiskFileName` after that. Handlers
 * read this record. They do not open `file.path` or `file.destination`.
 */
export function pinDiskUpload(req: object, directory: string, filePath = ''): void {
  pins.set(req, { directory, filePath });
}

export function attachDiskFileName(req: object, fileName: string): boolean {
  const pinned = pins.get(req);
  if (!pinned) return false;
  const stored = payloadFileName(fileName);
  if (!stored) return false;
  pinned.filePath = `${pinned.directory}${sep}${stored}`;
  return true;
}

/**
 * Directory we created, after symlink resolution. Refuses anything
 * that is not a `gg-ingest-*` directory inside the OS temp dir.
 * `path.relative` plus a `..` check is the containment test. A
 * string prefix would accept a sibling such as `gg-ingest-evil`.
 */
export function containedIngestDirectory(directory: string): string {
  const tmpRoot = realpathSync(tmpdir());
  const realDir = realpathSync(directory);
  const rel = relative(tmpRoot, realDir);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
    throw new BadRequestException('Upload directory was not accepted.');
  }
  if (basename(realDir) === basename(tmpRoot) || !basename(realDir).startsWith('gg-ingest-')) {
    throw new BadRequestException('Upload directory was not accepted.');
  }
  return realDir;
}

/**
 * Real path of the one file we stored for this request. The request's
 * original filename is not an argument. A symlink that leaves the
 * temp directory is rejected, and so is `..` as a file name.
 */
export function containedPayloadFile(filePath: string): string {
  const real = realpathSync(filePath);
  const directory = containedIngestDirectory(dirname(real));
  const storedName = payloadFileName(basename(real));
  if (!storedName) {
    throw new BadRequestException('Upload file was not accepted.');
  }
  const rel = relative(directory, real);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || rel !== storedName) {
    throw new BadRequestException('Upload path escapes its directory.');
  }
  return real;
}

export function takeContainedDiskUpload(req: object): {
  directory: string;
  filePath: string;
} {
  const pinned = pins.get(req);
  if (!pinned || pinned.filePath.length === 0) {
    throw new BadRequestException('Upload was not accepted.');
  }
  const filePath = containedPayloadFile(pinned.filePath);
  const directory = containedIngestDirectory(dirname(filePath));
  return { directory, filePath };
}

/**
 * Delete the temp directory for `req` when it still belongs to this
 * process. A path that fails the containment check is left in place
 * rather than removed from a caller-supplied string.
 */
export async function discardDiskUpload(req: object): Promise<void> {
  const pinned = pins.get(req);
  if (!pinned) return;
  pins.delete(req);
  let directory: string;
  try {
    directory = containedIngestDirectory(pinned.directory);
  } catch {
    return;
  }
  await rm(directory, { recursive: true, force: true });
}
