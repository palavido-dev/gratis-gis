// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { diskStorage } from 'multer';

/** 1 GB, matching IngestService.maxBytes. */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * multer options that write an ingest upload straight to a per-request
 * temp directory on disk instead of buffering it in memory. Memory
 * storage held the whole file (up to 1 GB) in the API replica's heap
 * for the duration of the request, so two concurrent county-scale
 * imports could exceed the box; disk storage bounds memory to nothing.
 *
 * Each upload gets its own `mkdtemp` dir with the sanitised original
 * filename inside, mirroring IngestService.materializeBufferToTemp, so
 * GDAL/OGR still sees the extension it needs to select a driver and one
 * upload's file cannot collide with another's. The handler removes
 * `file.destination` (the temp dir) when it is done, unless the file
 * was moved out of it (the stage path renames it away).
 */
export const INGEST_DISK_UPLOAD = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      mkdtemp(join(tmpdir(), 'gg-ingest-')).then(
        (dir) => cb(null, dir),
        (err) => cb(err instanceof Error ? err : new Error(String(err)), ''),
      );
    },
    filename: (_req, file, cb) => cb(null, safeUploadName(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

/**
 * Strip directory components and anything outside a conservative
 * allowlist, but keep the extension so GDAL can still sniff the format
 * from the path.
 */
function safeUploadName(name: string): string {
  const cleaned = basename(name).replace(/[^\w.\- ]+/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : `upload${extname(name)}`;
}
