// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from '@nestjs/common';

import type { BackupService } from './backup.service.js';
import type { OffsiteSettings } from './offsite-config.js';
import type { SealKey } from './offsite-crypto.js';
import type { S3Like } from './offsite-store.js';

/**
 * Incremental mirror mode for large object stores. Not available yet:
 * every run uploads the whole archive.
 */
export class OffsiteMirror {
  readonly available = false;

  constructor(
    private readonly log: Logger,
    private readonly backup: BackupService,
  ) {}

  upload(_a: {
    s3: S3Like;
    s: OffsiteSettings;
    key: SealKey;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    signal: AbortSignal;
    beat: () => Promise<void>;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    return Promise.reject(new Error('Mirror mode is not available in this version.'));
  }

  enforceRetention(_s: OffsiteSettings, _s3: S3Like, _now: Date): Promise<number> {
    return Promise.resolve(0);
  }
}
