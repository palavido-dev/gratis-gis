// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Help docs are read and rendered once per production process. A doc
 * page used to walk and render every file several times per request.
 */
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readdir: jest.fn(actual.readdir) };
});

import { readdir } from 'node:fs/promises';

describe('loadAllDocs', () => {
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  afterEach(() => {
    env.NODE_ENV = before;
  });

  it('reads the help tree once in production and hands out copies', async () => {
    env.NODE_ENV = 'production';
    let mod: typeof import('./content') | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('./content') as typeof import('./content');
    });
    const first = await mod!.loadAllDocs();
    const calls = (readdir as unknown as jest.Mock).mock.calls.length;
    expect(first.length).toBeGreaterThan(0);
    first.pop();
    const second = await mod!.loadAllDocs();
    expect((readdir as unknown as jest.Mock).mock.calls.length).toBe(calls);
    expect(second.length).toBe(first.length + 1);
  });
});
