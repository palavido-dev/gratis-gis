// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  PartPutError,
  resumableUpload,
  resumableUploadErrorText,
  ResumableUploadError,
  type PutPart,
  type ResumableProgress,
  type UploadMemory,
} from './resumable-upload';

const PART = 10;

/** A file of `size` bytes with a fixed name and mtime. */
function file(size: number) {
  const blob = new Blob([new Uint8Array(size)]);
  return {
    name: 'parcels.gpkg',
    size,
    lastModified: 1_700_000_000_000,
    slice: (a: number, b: number) => blob.slice(a, b),
  };
}

function memory(): UploadMemory & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface FakeServer {
  fetchImpl: typeof fetch;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  stored: Set<number>;
  putPart: PutPart;
  puts: number[];
}

/**
 * A stand-in for portal-api plus storage. `partCount` parts of PART
 * bytes. `failPut` lists part numbers whose first PUT fails.
 */
function server(
  partCount: number,
  opts: {
    stored?: number[];
    failPut?: number[];
    completeStatuses?: number[];
    startStatus?: number;
  } = {},
): FakeServer {
  const calls: FakeServer['calls'] = [];
  const stored = new Set(opts.stored ?? []);
  const failOnce = new Set(opts.failPut ?? []);
  const completeStatuses = [...(opts.completeStatuses ?? [])];
  const puts: number[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === 'start') {
      if (opts.startStatus) {
        return json(opts.startStatus, {
          message: 'Importing files requires the contributor or admin role.',
        });
      }
      return json(200, { handle: 'h1', partSize: PART, partCount });
    }
    if (path === 'status') {
      return json(200, {
        partSize: PART,
        partCount,
        uploadedParts: [...stored].map((partNumber) => ({ partNumber, size: PART })),
      });
    }
    if (path === 'sign') {
      const nums = body.partNumbers as number[];
      return json(200, { parts: nums.map((n) => ({ partNumber: n, url: `u${n}` })) });
    }
    if (path === 'complete') {
      const status = completeStatuses.shift() ?? 200;
      if (status !== 200) return json(status, { message: 'Too many imports are already running.' });
      return json(200, { stagingId: 's1', driver: 'GPKG', layers: [] });
    }
    if (path === 'abort') return json(200, { aborted: true });
    return json(404, {});
  }) as typeof fetch;
  const putPart: PutPart = async (url, body, onProgress) => {
    const n = Number(url.slice(1));
    puts.push(n);
    if (failOnce.delete(n)) throw new PartPutError(500);
    onProgress(body.size);
    stored.add(n);
  };
  return { fetchImpl, calls, stored, putPart, puts };
}

const noSleep = async () => undefined;

describe('resumableUpload', () => {
  it('uploads every part, keeps progress, and returns the stage response', async () => {
    const s = server(3);
    const mem = memory();
    const events: ResumableProgress[] = [];
    const out = await resumableUpload<{ stagingId: string }>(file(25), (e) => events.push(e), {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: mem,
      sleep: noSleep,
    });
    expect(out.stagingId).toBe('s1');
    expect([...s.stored].sort()).toEqual([1, 2, 3]);
    expect(s.calls[0]).toEqual({
      path: 'start',
      body: { fileName: 'parcels.gpkg', sizeBytes: 25 },
    });
    expect(s.calls.at(-1)!.path).toBe('complete');
    expect(events.at(-1)).toEqual({ phase: 'reading', bytesUploaded: 25, resumed: false });
    expect(Math.max(...events.map((e) => e.bytesUploaded))).toBe(25);
    // Done, so nothing is left to resume.
    expect(mem.data.size).toBe(0);
  });

  it('resumes a saved upload and sends only the missing parts', async () => {
    const s = server(3, { stored: [1, 3] });
    const mem = memory();
    mem.setItem(
      'gg-resumable-upload:v1:parcels.gpkg:25:1700000000000',
      JSON.stringify({ handle: 'h1', partSize: PART, partCount: 3, done: [1] }),
    );
    const events: ResumableProgress[] = [];
    await resumableUpload(file(25), (e) => events.push(e), {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: mem,
      sleep: noSleep,
    });
    expect(s.calls.map((c) => c.path)).not.toContain('start');
    expect(s.calls[0]!.path).toBe('status');
    expect(s.puts).toEqual([2]);
    expect(events[0]).toEqual({ phase: 'uploading', bytesUploaded: 15, resumed: true });
  });

  it('starts over when the saved upload is no longer valid', async () => {
    const s = server(1);
    const base = s.fetchImpl;
    s.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) {
        return new Response(JSON.stringify({ message: 'This upload no longer exists.' }), {
          status: 404,
        });
      }
      return base(input, init);
    }) as typeof fetch;
    const mem = memory();
    mem.setItem(
      'gg-resumable-upload:v1:parcels.gpkg:5:1700000000000',
      JSON.stringify({ handle: 'old', partSize: PART, partCount: 1, done: [] }),
    );
    await resumableUpload(file(5), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: mem,
      sleep: noSleep,
    });
    expect(s.calls.map((c) => c.path)).toEqual(['start', 'sign', 'complete']);
  });

  it('retries a failed part', async () => {
    const s = server(2, { failPut: [2] });
    await resumableUpload(file(20), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: memory(),
      sleep: noSleep,
    });
    expect(s.puts.filter((n) => n === 2)).toHaveLength(2);
  });

  it('gives up after the retries and keeps the state for a later resume', async () => {
    const s = server(1);
    const mem = memory();
    const failing: PutPart = async () => {
      throw new PartPutError(0);
    };
    const err = await resumableUpload(file(5), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: failing,
      memory: mem,
      retryDelaysMs: [1, 1],
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumableUploadError);
    expect((err as ResumableUploadError).code).toBe('part');
    expect(mem.data.size).toBe(1);
    expect(resumableUploadErrorText(err, (k) => k)).toBe('resumableUpload.partFailed');
  });

  it('asks again when the server is busy finishing', async () => {
    const s = server(1, { completeStatuses: [429] });
    await resumableUpload(file(5), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: memory(),
      sleep: noSleep,
    });
    expect(s.calls.filter((c) => c.path === 'complete')).toHaveLength(2);
  });

  it('passes a server refusal through with its status', async () => {
    const s = server(1, { startStatus: 403 });
    const err = await resumableUpload(file(5), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: s.putPart,
      memory: memory(),
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumableUploadError);
    expect((err as Error).message).toMatch(/contributor or admin/);
    expect((err as ResumableUploadError).status).toBe(403);
  });

  it('cancel aborts the server upload and forgets it', async () => {
    const s = server(3);
    const mem = memory();
    const controller = new AbortController();
    const hanging: PutPart = (_url, _body, _p, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        controller.abort();
      });
    const err = await resumableUpload(file(25), () => {}, {
      fetchImpl: s.fetchImpl,
      putPart: hanging,
      memory: mem,
      signal: controller.signal,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.at(-1)).toEqual({ path: 'abort', body: { handle: 'h1' } });
    expect(mem.data.size).toBe(0);
  });
});
