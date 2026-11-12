// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskStorage } from 'multer';

import { attachDiskFileName, pinDiskUpload, serverUploadName } from './ingest-disk-path.js';
import { INGEST_MAX_UPLOAD_BYTES } from './ingest-upload-handle.js';
import { COLLECT_MAX_UPLOAD_BYTES } from './collect-limits.js';

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
 */
export const INGEST_DISK_UPLOAD = {
  storage: diskStorage({
    destination: (req, _file, cb) => {
      mkdtemp(join(tmpdir(), 'gg-ingest-')).then(
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
  }),
  // Sanity ceiling only. Free disk is the real limit, checked by the
  // handlers before they parse.
  limits: { fileSize: INGEST_MAX_UPLOAD_BYTES },
};

/**
 * Same storage, smaller ceiling, for the routes that read the whole
 * file into memory and return it (collect-limits.ts).
 */
export const INGEST_COLLECT_UPLOAD = {
  ...INGEST_DISK_UPLOAD,
  limits: { fileSize: COLLECT_MAX_UPLOAD_BYTES },
};
