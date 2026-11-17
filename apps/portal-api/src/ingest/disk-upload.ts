// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskStorage } from 'multer';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { hasCapability } from '../auth/capabilities.js';
import { attachDiskFileName, pinDiskUpload, serverUploadName } from './ingest-disk-path.js';
import { INGEST_MAX_UPLOAD_BYTES } from './ingest-upload-handle.js';
import { COLLECT_MAX_UPLOAD_BYTES } from './collect-limits.js';
import {
  INGEST_DISK_HEADROOM_BYTES,
  IngestBusyException,
  IngestDiskException,
} from './ingest-slots.js';

/**
 * multer options that write an ingest upload straight to a per-request
 * temp directory on disk instead of buffering it in memory. Memory
 * storage held the whole file in the API replica's heap
 * for the duration of the request, so two concurrent county-scale
 * imports could exceed the box; disk storage bounds memory to nothing.
 *
 * Each upload gets its own `mkdtemp` directory. The file inside it is
 * a sanitized stem of the request's filename plus an extension from a
 * fixed list, so GDAL still sees a format hint and names a GeoJSON or
 * CSV layer after the picked file, and the stored name is not a path.
 * `..` used to survive as a filename and `join(tempDir, '..')` left
 * the directory. Handlers open the path recorded here, then delete
 * that directory. They do not open `file.path`.
 *
 * Admission runs here, in `destination`, which multer calls when the
 * file part starts and before any of its bytes are written. The
 * handlers' own checks run only after the whole body is on disk, so
 * they could not stop a caller (even one about to get a 403) from
 * filling the disk with uploads that were never going to be used.
 */

/** Uploads one user may be sending at once. */
const MAX_RECEIVING_PER_USER = 2;

/** Bytes declared by uploads still arriving, and per-user counts. */
let receivingBytes = 0;
const receivingPerUser = new Map<string, number>();

/** Test hook. */
export function resetUploadAdmissionForTests(): void {
  receivingBytes = 0;
  receivingPerUser.clear();
}

async function freeBytesAt(dir: string): Promise<number> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.NaN;
  }
}

/**
 * Admit one upload or throw. Counts it until the request body has
 * been read; after that its bytes are on disk and the handlers'
 * free-space check sees them.
 */
export async function admitUpload(
  req: Request,
  opts: { requirePublish: boolean; dir?: string; freeBytes?: number },
): Promise<void> {
  const user = (req as Request & { user?: AuthUser }).user;
  if (opts.requirePublish && !(user && hasCapability(user, 'can_publish_items'))) {
    throw new ForbiddenException('Importing files requires the contributor or admin role.');
  }
  const userKey = user?.id ?? 'anonymous';
  if ((receivingPerUser.get(userKey) ?? 0) >= MAX_RECEIVING_PER_USER) {
    throw new IngestBusyException();
  }
  const declared = Number(req.headers['content-length'] ?? '');
  const bytes = Number.isFinite(declared) && declared > 0 ? declared : 0;
  // Free space already reflects the part of other uploads written so
  // far, and their full declared size is added again here: this errs
  // on the side of refusing, never of overfilling.
  const free = opts.freeBytes ?? (await freeBytesAt(opts.dir ?? tmpdir()));
  if (
    !Number.isFinite(free) ||
    free < receivingBytes + bytes + INGEST_DISK_HEADROOM_BYTES
  ) {
    throw new IngestDiskException();
  }
  receivingBytes += bytes;
  receivingPerUser.set(userKey, (receivingPerUser.get(userKey) ?? 0) + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    receivingBytes = Math.max(0, receivingBytes - bytes);
    const next = (receivingPerUser.get(userKey) ?? 1) - 1;
    if (next <= 0) receivingPerUser.delete(userKey);
    else receivingPerUser.set(userKey, next);
  };
  req.once('end', release);
  req.once('close', release);
}

function diskStorageFor(requirePublish: boolean) {
  return diskStorage({
    destination: (req, _file, cb) => {
      admitUpload(req, { requirePublish })
        .then(() => mkdtemp(join(tmpdir(), INGEST_TEMP_PREFIX)))
        .then(
          (dir) => {
            pinDiskUpload(req, dir);
            cb(null, dir);
          },
          (err) => cb(err instanceof Error ? err : new Error(String(err)), ''),
        );
    },
    filename: (req, file, cb) => {
      const name = serverUploadName(file.originalname);
      if (!attachDiskFileName(req, name)) {
        cb(new Error('Upload directory was not created.'), '');
        return;
      }
      cb(null, name);
    },
  });
}

/** Name prefix of the per-request temp directories. */
export const INGEST_TEMP_PREFIX = 'gg-ingest-';

export const INGEST_DISK_UPLOAD = {
  storage: diskStorageFor(false),
  // Sanity ceiling only. Free disk is the real limit, checked above
  // before any bytes land and again by the handlers before they parse.
  limits: { fileSize: INGEST_MAX_UPLOAD_BYTES },
};

/**
 * Same, for the wizard routes (probe, stage) that need the publish
 * capability: a caller without it is refused before the body is read.
 */
export const INGEST_PUBLISH_UPLOAD = {
  ...INGEST_DISK_UPLOAD,
  storage: diskStorageFor(true),
};

/**
 * Same storage, smaller ceiling, for the routes that read the whole
 * file into memory and return it (collect-limits.ts).
 */
export const INGEST_COLLECT_UPLOAD = {
  ...INGEST_DISK_UPLOAD,
  limits: { fileSize: COLLECT_MAX_UPLOAD_BYTES },
};

/**
 * Remove `gg-ingest-*` temp directories nothing has touched for
 * `maxAgeMs`. Handlers delete their own, but a throw before a
 * handler's cleanup, or an upload multer aborted (it removes the
 * partial file, not the directory), left them for good. Age is the
 * newest mtime of the directory and the files in it, so an upload
 * still being written is never taken.
 */
export async function sweepStaleIngestTempDirs(
  maxAgeMs: number,
  root: string = tmpdir(),
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(INGEST_TEMP_PREFIX)) continue;
    const dir = join(root, e.name);
    try {
      let newest = (await stat(dir)).mtimeMs;
      for (const f of await readdir(dir)) {
        newest = Math.max(newest, (await stat(join(dir, f))).mtimeMs);
      }
      if (now - newest < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* gone already, or not ours to read */
    }
  }
  return removed;
}
