// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { connect } from 'node:net';

import {
  EXECUTOR_JSON_BODY_LIMIT,
  bodyReadDeadline,
  configureBodyParsers,
  rejectRepeatedQueryKeys,
} from './body-limits.js';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: { blob: string }) {
    return { length: body.blob.length };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

async function startApp(configure: boolean) {
  const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  if (configure) configureBodyParsers(app);
  await app.listen(0);
  const url = await app.getUrl();
  return { app, url: url.replace('[::1]', '127.0.0.1') };
}

async function post(url: string, bytes: number) {
  const res = await fetch(`${url}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: 'x'.repeat(bytes) }),
  });
  return res.status;
}

describe('JSON body limit (#679)', () => {
  it('Nest on its own refuses a 500 KB body, which is the reported 413', async () => {
    const { app, url } = await startApp(false);
    try {
      expect(await post(url, 500_000)).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('accepts a 500 KB body and still refuses one over the limit', async () => {
    const { app, url } = await startApp(true);
    try {
      expect(await post(url, 500_000)).toBe(201);
      expect(await post(url, 11 * 1024 * 1024)).toBe(413);
    } finally {
      await app.close();
    }
  });
});

describe('script executor body limit', () => {
  it('accepts a 256 KB source after JSON escaping', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useBodyParser('json', { limit: EXECUTOR_JSON_BODY_LIMIT });
    await app.listen(0);
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    try {
      // Every quote escaped: about twice the source size on the wire.
      const res = await fetch(`${url}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob: '"'.repeat(256 * 1024) }),
      });
      expect(res.status).toBe(201);
    } finally {
      await app.close();
    }
  });
});

describe('bodyReadDeadline', () => {
  async function startWithDeadline(ms: number) {
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(bodyReadDeadline(ms));
    configureBodyParsers(app);
    await app.listen(0);
    const server = app.getHttpServer() as { address(): { port: number } };
    return { app, port: server.address().port };
  }

  function stall(port: number, contentType: string): Promise<'closed' | 'open'> {
    return new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: ${contentType}\r\n`
          + 'Content-Length: 1000\r\n\r\n{"blob":"',
        );
      });
      sock.on('error', () => undefined);
      const t = setTimeout(() => {
        sock.destroy();
        resolve('open');
      }, 1500);
      sock.on('close', () => {
        clearTimeout(t);
        resolve('closed');
      });
    });
  }

  it('drops a JSON body that stalls past the deadline', async () => {
    const { app, port } = await startWithDeadline(200);
    try {
      expect(await stall(port, 'application/json')).toBe('closed');
    } finally {
      await app.close();
    }
  });

  it('leaves multipart uploads alone', async () => {
    const { app, port } = await startWithDeadline(200);
    try {
      expect(await stall(port, 'multipart/form-data; boundary=x')).toBe('open');
    } finally {
      await app.close();
    }
  });

  it('does not touch a request that arrived in full', async () => {
    const { app } = await startWithDeadline(50);
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    try {
      expect(await post(url, 10)).toBe(201);
    } finally {
      await app.close();
    }
  });
});

describe('rejectRepeatedQueryKeys', () => {
  function run(query: Record<string, unknown>) {
    const res = {
      code: 0,
      status(c: number) {
        this.code = c;
        return this;
      },
      json: jest.fn(),
    };
    const next = jest.fn();
    rejectRepeatedQueryKeys({ query } as never, res as never, next);
    return { res, next };
  }

  it('passes single values through', () => {
    expect(run({ bbox: '1,2,3,4', q: 'x' }).next).toHaveBeenCalled();
  });

  it('answers a repeated key with 400 instead of letting a handler throw', () => {
    const { res, next } = run({ bbox: ['1', '2'] });
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(400);
  });
});
