// SPDX-License-Identifier: AGPL-3.0-or-later
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { BadRequestException } from '@nestjs/common';

/**
 * Extensions the product already accepts. The stored name is one of
 * these constants (or `payload.bin`). The characters from the
 * request are compared and then discarded. They are never joined onto
 * a directory.
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

/**
 * Name multer may write. `..`, absolute paths, and unknown extensions
 * become `payload.bin`. A known extension is copied from this list,
 * not from the request string.
 */
export function serverUploadName(originalName: string): string {
  const base = basename(typeof originalName === 'string' ? originalName : '');
  const dot = base.lastIndexOf('.');
  const ext = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  for (const allowed of PAYLOAD_EXTENSIONS) {
    if (ext === allowed) return `payload${allowed}`;
  }
  return 'payload.bin';
}

/** The stored name, or null when `name` is not one this process chose. */
export function payloadFileName(name: string): string | null {
  if (name === 'payload.bin') return 'payload.bin';
  for (const allowed of PAYLOAD_EXTENSIONS) {
    if (name === `payload${allowed}`) return `payload${allowed}`;
  }
  return null;
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
