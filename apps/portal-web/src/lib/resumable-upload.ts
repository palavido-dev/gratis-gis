// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resumable import upload (#573).
 *
 * The old import posted the whole file through the web app's proxy to
 * portal-api. That path hit Caddy's request cap, then the 5 minute
 * Node request timeout, and a dropped connection meant starting over.
 *
 * This client asks portal-api to open an S3 multipart upload, then
 * PUTs the file straight to storage in parts with presigned URLs. A
 * few parts go at once, and a failed part is retried with backoff.
 * The upload handle and the finished part numbers are kept in
 * localStorage, keyed by the file's name, size and lastModified. When
 * the user picks the same file again after a drop or a closed tab,
 * the client asks which parts the server already has and sends only
 * the rest. When every part is in, portal-api stages the file and
 * returns the same `{ stagingId, driver, layers }` as
 * `POST /ingest/stage`.
 *
 * The progress callback has the same shape as `uploadWithProgress`,
 * plus `resumed` so the panel can say "Resuming".
 */
import { apiErrorMessage } from '@/lib/api-error';

export const RESUMABLE_UPLOAD_BASE = '/api/portal/ingest/upload';

/** Parts sent at the same time. */
const DEFAULT_CONCURRENCY = 4;

/** Wait before each retry of a failed part. Four retries in all. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000];

/** Part URLs asked for in one call. The server allows up to 100. */
const SIGN_BATCH = 16;

/** Part URLs are valid for an hour. Ask again well before that. */
const URL_MAX_AGE_MS = 45 * 60 * 1000;

const STORAGE_PREFIX = 'gg-resumable-upload:v1:';

export interface ResumableProgress {
  phase: 'uploading' | 'reading';
  bytesUploaded: number;
  /** True when this upload continues one that was interrupted. */
  resumed?: boolean;
}

/** The parts of a File this client reads. A plain Blob with these works in tests. */
export interface UploadSource {
  name: string;
  size: number;
  lastModified: number;
  slice(start: number, end: number): Blob;
}

/** PUT one part. Resolves on 2xx. Rejects with a PartPutError otherwise. */
export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
) => Promise<void>;

/** Storage the client may use to remember an upload. */
export type UploadMemory = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ResumableUploadOptions {
  /** Abort to cancel. The server-side upload is dropped too. */
  signal?: AbortSignal;
  concurrency?: number;
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
  putPart?: PutPart;
  /** Defaults to window.localStorage when there is one. */
  memory?: UploadMemory | null;
  /** Test seam for backoff waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * A failed upload. `code` lets the page pick a translated sentence for
 * failures this client detects itself. Server refusals carry the
 * server's own message and `code: 'server'`.
 */
export class ResumableUploadError extends Error {
  readonly code: 'server' | 'network' | 'part';
  readonly status: number | null;

  constructor(message: string, code: 'server' | 'network' | 'part', status: number | null) {
    super(message);
    this.name = 'ResumableUploadError';
    this.code = code;
    this.status = status;
  }
}

/** A part PUT that storage refused or that never arrived. */
export class PartPutError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Part upload failed (${status}).`);
    this.name = 'PartPutError';
    this.status = status;
  }
}

interface Saved {
  handle: string;
  partSize: number;
  partCount: number;
  done: number[];
}

function abortError(): Error {
  const e = new Error('Upload cancelled.');
  e.name = 'AbortError';
  return e;
}

function defaultMemory(): UploadMemory | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function memoryKey(file: UploadSource): string {
  return `${STORAGE_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function readSaved(memory: UploadMemory | null, key: string): Saved | null {
  if (!memory) return null;
  try {
    const raw = memory.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    if (
      typeof v.handle !== 'string' ||
      typeof v.partSize !== 'number' ||
      typeof v.partCount !== 'number' ||
      !Array.isArray(v.done)
    ) {
      return null;
    }
    return {
      handle: v.handle,
      partSize: v.partSize,
      partCount: v.partCount,
      done: v.done.filter((n): n is number => Number.isInteger(n)),
    };
  } catch {
    return null;
  }
}

function writeSaved(memory: UploadMemory | null, key: string, saved: Saved): void {
  if (!memory) return;
  try {
    memory.setItem(key, JSON.stringify(saved));
  } catch {
    // Full or blocked storage only costs the ability to resume.
  }
}

function forget(memory: UploadMemory | null, key: string): void {
  if (!memory) return;
  try {
    memory.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function partLength(size: number, partSize: number, partCount: number, n: number): number {
  return n < partCount ? partSize : size - partSize * (partCount - 1);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** XHR PUT, because fetch has no upload progress. */
export const xhrPutPart: PutPart = (url, body, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (ev) => onProgress(ev.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PartPutError(xhr.status));
    };
    xhr.onerror = () => reject(new PartPutError(0));
    xhr.ontimeout = () => reject(new PartPutError(0));
    xhr.onabort = () => reject(abortError());
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });

/**
 * Upload `file` and return what `/ingest/upload/complete` returns.
 * Rejects with an AbortError on cancel and a ResumableUploadError on
 * failure.
 */
export async function resumableUpload<T>(
  file: UploadSource,
  onProgress: (e: ResumableProgress) => void,
  options: ResumableUploadOptions = {},
): Promise<T> {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const putPart = options.putPart ?? xhrPutPart;
  const memory = options.memory === undefined ? defaultMemory() : options.memory;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  // One controller for everything in flight. The caller's signal feeds
  // it, and a fatal part error also trips it so the other parts stop.
  const inner = new AbortController();
  const outer = options.signal;
  const onOuterAbort = () => inner.abort();
  if (outer) {
    if (outer.aborted) throw abortError();
    outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const signal = inner.signal;
  const key = memoryKey(file);

  async function call<R>(path: string, body: unknown): Promise<R> {
    let res: Response;
    try {
      res = await doFetch(`${RESUMABLE_UPLOAD_BASE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw abortError();
      throw new ResumableUploadError(
        err instanceof Error ? err.message : String(err),
        'network',
        null,
      );
    }
    if (!res.ok) {
      throw new ResumableUploadError(
        await apiErrorMessage(res, 'Upload failed'),
        'server',
        res.status,
      );
    }
    return (await res.json()) as R;
  }

  let saved: Saved | null = null;
  try {
    // 1. Continue a saved upload for this exact file, or start one.
    const previous = readSaved(memory, key);
    let resumed = false;
    if (previous) {
      try {
        const status = await call<{
          partSize: number;
          partCount: number;
          uploadedParts: Array<{ partNumber: number }>;
        }>('status', { handle: previous.handle });
        if (status.partSize === previous.partSize && status.partCount === previous.partCount) {
          saved = {
            ...previous,
            done: status.uploadedParts.map((p) => p.partNumber),
          };
          resumed = saved.done.length > 0;
        }
      } catch (err) {
        // Expired, gone, or someone else's: start over. A network
        // failure is real and goes to the caller.
        if (!(err instanceof ResumableUploadError && err.code === 'server')) throw err;
      }
      if (!saved) forget(memory, key);
    }
    if (!saved) {
      const started = await call<{
        handle: string;
        partSize: number;
        partCount: number;
      }>('start', { fileName: file.name, sizeBytes: file.size });
      saved = {
        handle: started.handle,
        partSize: started.partSize,
        partCount: started.partCount,
        done: [],
      };
      writeSaved(memory, key, saved);
    }
    const s = saved;
    const length = (n: number) => partLength(file.size, s.partSize, s.partCount, n);

    // 2. Send the missing parts.
    const done = new Set(s.done);
    let doneBytes = 0;
    for (const n of done) doneBytes += length(n);
    const inFlight = new Map<number, number>();
    const report = () => {
      let bytes = doneBytes;
      for (const v of inFlight.values()) bytes += v;
      onProgress({
        phase: 'uploading',
        bytesUploaded: Math.min(file.size, bytes),
        resumed,
      });
    };
    report();

    const pending: number[] = [];
    for (let n = 1; n <= s.partCount; n += 1) if (!done.has(n)) pending.push(n);
    const urls = new Map<number, { url: string; at: number }>();
    let signing: Promise<void> | null = null;

    async function urlFor(n: number): Promise<string> {
      for (;;) {
        const hit = urls.get(n);
        if (hit && Date.now() - hit.at < URL_MAX_AGE_MS) return hit.url;
        if (!signing) {
          const wanted = [n];
          for (const m of pending) {
            if (wanted.length >= SIGN_BATCH) break;
            if (m !== n && !done.has(m) && !urls.has(m)) wanted.push(m);
          }
          signing = call<{ parts: Array<{ partNumber: number; url: string }> }>('sign', {
            handle: s.handle,
            partNumbers: wanted,
          })
            .then((out) => {
              const at = Date.now();
              for (const p of out.parts) urls.set(p.partNumber, { url: p.url, at });
            })
            .finally(() => {
              signing = null;
            });
        }
        await signing;
        if (!urls.has(n)) {
          // Another worker's batch did not include this part. Loop
          // and ask for it.
          continue;
        }
      }
    }

    async function sendPart(n: number): Promise<void> {
      const start = (n - 1) * s.partSize;
      const blob = file.slice(start, start + length(n));
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) throw abortError();
        try {
          const url = await urlFor(n);
          inFlight.set(n, 0);
          await putPart(
            url,
            blob,
            (loaded) => {
              inFlight.set(n, loaded);
              report();
            },
            signal,
          );
          inFlight.delete(n);
          done.add(n);
          doneBytes += length(n);
          s.done = [...done];
          writeSaved(memory, key, s);
          report();
          return;
        } catch (err) {
          inFlight.delete(n);
          if (signal.aborted) throw abortError();
          // A refused sign call is final. A part PUT is worth another try.
          if (err instanceof ResumableUploadError && err.code === 'server') throw err;
          // 403 is usually an expired URL. Sign again on the next try.
          if (err instanceof PartPutError && err.status === 403) urls.delete(n);
          if (attempt >= delays.length) {
            throw new ResumableUploadError(
              err instanceof Error ? err.message : String(err),
              err instanceof PartPutError ? 'part' : 'network',
              err instanceof PartPutError ? err.status : null,
            );
          }
          report();
          await sleep(delays[attempt]!, signal);
        }
      }
    }

    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const n = pending[next]!;
        next += 1;
        await sendPart(n);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker),
      );
    } catch (err) {
      // Stop the other parts. The saved state stays so a retry resumes,
      // unless the caller cancelled.
      inner.abort();
      throw err;
    }

    // 3. Finish. The server stages and probes the file. A busy server
    // (429) is asked again after a pause. Any other answer means the
    // upload is used up, so the saved state is dropped.
    onProgress({ phase: 'reading', bytesUploaded: file.size, resumed });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const out = await call<T>('complete', { handle: s.handle });
        forget(memory, key);
        return out;
      } catch (err) {
        if (err instanceof ResumableUploadError && err.code === 'server') {
          if (err.status === 429 && attempt < delays.length) {
            await sleep(delays[attempt]!, signal);
            continue;
          }
          if (err.status !== 429) forget(memory, key);
        }
        throw err;
      }
    }
  } catch (err) {
    if (signal.aborted && outer?.aborted) {
      // Cancel: drop the server-side upload and forget it here. Sent
      // without the aborted signal, and keepalive so a closing page
      // still sends it.
      forget(memory, key);
      if (saved) {
        void doFetch(`${RESUMABLE_UPLOAD_BASE}/abort`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle: saved.handle }),
          keepalive: true,
        }).catch(() => undefined);
      }
      throw abortError();
    }
    throw err;
  } finally {
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Sentence for a failed upload. Server refusals keep the server's
 * message. Failures this client found get a translated sentence.
 */
export function resumableUploadErrorText(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof ResumableUploadError) {
    if (err.code === 'network') return t('resumableUpload.networkError');
    if (err.code === 'part') return t('resumableUpload.partFailed');
    return err.message;
  }
  return err instanceof Error && err.message ? err.message : t('resumableUpload.failed');
}
