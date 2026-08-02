// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resilient batch upload orchestration (#202).
 *
 * Born from a real failure: a 311-tile, ~11GB batch died at tile 92
 * because ONE presign call caught a 502 during an api restart, and
 * the sequential all-or-nothing loop threw away 91 uploaded tiles.
 * A 300-file batch that needs 300 consecutive round-trips to all
 * succeed is fragile by construction.
 *
 * What this does instead:
 *  - bounded concurrency (default 3): hundreds of strictly
 *    sequential round-trips are slow, unbounded parallelism is how
 *    you hammer your own api into the failure you are guarding
 *    against
 *  - per-file retry with exponential backoff + jitter on transient
 *    failures (network errors, 5xx, 429); no retry on clear client
 *    errors (413 too large, 400 bad request)
 *  - continue on failure: one hopeless file does not abort the
 *    batch; every failure is reported at the end with its reason so
 *    the caller can offer "retry just the failed ones"
 *  - resume: the caller passes the descriptors that already
 *    succeeded this session and those files are skipped, so a retry
 *    only moves what is missing
 *
 * Kept framework-free (no React, no fetch specifics) on purpose:
 * the imagery mosaic uploader (#199) is expected to reuse it, and
 * pure orchestration is testable the moment a web test harness
 * exists.
 */

export interface BatchFileResult<T> {
  file: File;
  descriptor: T;
}

export interface BatchFailure {
  file: File;
  error: string;
}

export interface BatchOutcome<T> {
  /** Every file that made it, including ones skipped as already done. */
  succeeded: Array<BatchFileResult<T>>;
  failed: BatchFailure[];
}

/** Thrown by an uploader to say whether retrying can possibly help. */
export class UploadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'UploadError';
    this.retryable = retryable;
  }
}

export interface BatchUploadOptions<T> {
  /** Uploads one file; throws UploadError (or anything) on failure. */
  uploadOne: (file: File) => Promise<T>;
  /** Already-uploaded descriptors from this session, keyed by fileKey. */
  alreadyDone?: Map<string, T>;
  concurrency?: number;
  /** Retry attempts AFTER the first try, per file. */
  retries?: number;
  /** Base backoff delay; grows 1x, 2x, 4x with +-25% jitter. */
  backoffMs?: number;
  onFileStart?: (file: File, index: number, total: number) => void;
  onFileDone?: (done: number, total: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Stable identity for "the same file picked again": name + size +
 *  mtime. Content hashing would be stronger but reading gigabytes
 *  to hash them defeats the point of skipping. */
export function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRetryable(err: unknown): boolean {
  // Anything that did not declare itself is treated as transient:
  // network-level failures surface as bare TypeError/Error from
  // fetch/XHR, and those are exactly the blips retry exists for.
  return err instanceof UploadError ? err.retryable : true;
}

export async function uploadBatch<T>(
  files: File[],
  opts: BatchUploadOptions<T>,
): Promise<BatchOutcome<T>> {
  const {
    uploadOne,
    alreadyDone = new Map<string, T>(),
    concurrency = 3,
    retries = 3,
    backoffMs = 1_000,
    onFileStart,
    onFileDone,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const succeeded: Array<BatchFileResult<T>> = [];
  const failed: BatchFailure[] = [];
  let done = 0;
  let next = 0;

  async function uploadWithRetry(file: File): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await uploadOne(file);
      } catch (err) {
        if (!isRetryable(err) || attempt >= retries) throw err;
        const factor = 2 ** attempt;
        const jitter = 0.75 + Math.random() * 0.5;
        await sleep(Math.round(backoffMs * factor * jitter));
        attempt += 1;
      }
    }
  }

  async function workerLoop(): Promise<void> {
    // Shared cursor: each worker takes the next unclaimed index, so
    // file order of *starts* is preserved and concurrency is exact.
    while (next < files.length) {
      const index = next;
      next += 1;
      const file = files[index]!;
      const prior = alreadyDone.get(fileKey(file));
      if (prior !== undefined) {
        succeeded.push({ file, descriptor: prior });
        done += 1;
        onFileDone?.(done, files.length);
        continue;
      }
      onFileStart?.(file, index, files.length);
      try {
        const descriptor = await uploadWithRetry(file);
        succeeded.push({ file, descriptor });
      } catch (err) {
        failed.push({ file, error: errText(err) });
      }
      done += 1;
      onFileDone?.(done, files.length);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, files.length)) },
    () => workerLoop(),
  );
  await Promise.all(workers);
  return { succeeded, failed };
}
