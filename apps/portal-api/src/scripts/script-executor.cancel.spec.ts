// SPDX-License-Identifier: AGPL-3.0-or-later
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ScriptExecutorController } from './script-executor.controller.js';
import {
  ScriptExecutorService,
  type ExecuteResult,
} from './script-executor.service.js';

/**
 * Cancel is the claimer hanging up on a real HTTP request, so it has to
 * be tested over a real HTTP request. The controller used to listen for
 * 'close' on the request object. On Node 16+ that event fires as soon as
 * the JSON body has been read, before the handler runs, and never on a
 * hang-up. Every unit test passed, and no cancel ever reached a child.
 */
describe('script executor cancel over HTTP', () => {
  let app: INestApplication;
  let port: number;
  const seen: AbortSignal[] = [];
  let finishRun: (() => void) | null = null;

  const fake = {
    execute: jest.fn(
      (_req: unknown, signal?: AbortSignal): Promise<ExecuteResult> => {
        seen.push(signal!);
        return new Promise((resolve) => {
          const done = (killedBy: 'cancel' | null) =>
            resolve({ exitCode: 0, log: '', killedBy, notebook: null });
          finishRun = () => done(null);
          signal?.addEventListener('abort', () => done('cancel'), {
            once: true,
          });
        });
      },
    ),
  };

  beforeAll(async () => {
    process.env.SCRIPT_EXECUTOR_TOKEN = 'tok';
    const moduleRef = await Test.createTestingModule({
      controllers: [ScriptExecutorController],
      providers: [{ provide: ScriptExecutorService, useValue: fake }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seen.length = 0;
    finishRun = null;
    fake.execute.mockClear();
  });

  function post(): {
    req: ReturnType<typeof httpRequest>;
    response: Promise<string>;
  } {
    const body = JSON.stringify({ source: 'print(1)', apiKeyToken: 'ggk_x' });
    let resolveBody!: (s: string) => void;
    const response = new Promise<string>((r) => (resolveBody = r));
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/execute',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-script-executor-token': 'tok',
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolveBody(text));
      },
    );
    req.on('error', () => resolveBody(''));
    req.end(body);
    return { req, response };
  }

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const until = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > until) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('does not abort a run just because the request body was read', async () => {
    const { response } = post();
    await waitFor(() => seen.length === 1);
    // Give any stray 'close' a chance to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen[0]!.aborted).toBe(false);
    finishRun!();
    const text = await response;
    expect(JSON.parse(text).killedBy).toBeNull();
    expect(seen[0]!.aborted).toBe(false);
  });

  it('aborts the run when the caller hangs up', async () => {
    const { req } = post();
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.aborted).toBe(false);
    req.destroy();
    await waitFor(() => seen[0]!.aborted);
    expect(seen[0]!.aborted).toBe(true);
  });
});

describe('ScriptExecutorService run isolation', () => {
  let getuid: jest.SpyInstance | null = null;
  beforeAll(() => {
    // Run as an ordinary user so no uid drop or uid sweep is attempted.
    if (typeof process.getuid === 'function') {
      getuid = jest.spyOn(process, 'getuid').mockReturnValue(1000);
    }
  });
  afterAll(() => {
    getuid?.mockRestore();
  });

  it('never starts a run whose cancel landed before it began', async () => {
    const svc = new ScriptExecutorService();
    const ac = new AbortController();
    ac.abort();
    const out = await svc.execute(
      {
        source: 'print(1)',
        apiKeyToken: 'ggk_x',
        timeoutSeconds: 5,
        maxLogBytes: 1024,
      },
      ac.signal,
    );
    expect(out.killedBy).toBe('cancel');
    expect(out.exitCode).toBeNull();
  });

  it('runs one at a time even when two requests arrive together', async () => {
    const svc = new ScriptExecutorService();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const spy = jest
      .spyOn(
        svc as unknown as {
          executeAlone: (...a: unknown[]) => Promise<ExecuteResult>;
        },
        'executeAlone',
      )
      .mockImplementationOnce(async () => {
        order.push('a:start');
        await new Promise<void>((r) => (releaseFirst = r));
        order.push('a:end');
        return { exitCode: 0, log: '', killedBy: null, notebook: null };
      })
      .mockImplementationOnce(async () => {
        order.push('b:start');
        return { exitCode: 0, log: '', killedBy: null, notebook: null };
      });
    const req = {
      source: 'x',
      apiKeyToken: 'k',
      timeoutSeconds: 5,
      maxLogBytes: 1024,
    };
    const a = svc.execute(req);
    const b = svc.execute(req);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a:start']);
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    spy.mockRestore();
  });
});
