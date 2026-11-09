// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { configureBodyParsers } from './body-limits.js';

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
