// SPDX-License-Identifier: AGPL-3.0-or-later
import { updateFolderChildren, withChildIds } from './folder-update';

type Call = { url: string; init?: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
  return { calls, impl };
}

const smartFolder = {
  type: 'folder',
  updatedAt: '2026-11-13T10:00:00.000Z',
  data: {
    version: 1,
    childItemIds: ['a'],
    smartQuery: { types: ['map'] },
  },
};

describe('updateFolderChildren', () => {
  it('keeps the rest of the folder data and sends the updatedAt it read', async () => {
    const { calls, impl } = fakeFetch([json(smartFolder), json({})]);
    const out = await updateFolderChildren('f1', (ids) => [...ids, 'b'], impl);
    expect(out).toEqual({ changed: true });
    const body = JSON.parse(String(calls[1]!.init!.body));
    expect(body).toEqual({
      data: {
        version: 1,
        childItemIds: ['a', 'b'],
        smartQuery: { types: ['map'] },
      },
      expectedUpdatedAt: '2026-11-13T10:00:00.000Z',
    });
    expect(calls[1]!.init!.method).toBe('PATCH');
  });

  it('writes nothing when the change is a no-op', async () => {
    const { calls, impl } = fakeFetch([json(smartFolder)]);
    const out = await updateFolderChildren('f1', () => null, impl);
    expect(out).toEqual({ changed: false });
    expect(calls).toHaveLength(1);
  });

  it('re-reads and retries on a 409 so a concurrent add is kept', async () => {
    const newer = {
      ...smartFolder,
      updatedAt: '2026-11-13T10:00:01.000Z',
      data: { ...smartFolder.data, childItemIds: ['a', 'x'] },
    };
    const { calls, impl } = fakeFetch([
      json(smartFolder),
      json({ message: 'changed' }, 409),
      json(newer),
      json({}),
    ]);
    await updateFolderChildren('f1', (ids) => [...ids, 'b'], impl);
    const body = JSON.parse(String(calls[3]!.init!.body));
    expect(body.data.childItemIds).toEqual(['a', 'x', 'b']);
    expect(body.expectedUpdatedAt).toBe('2026-11-13T10:00:01.000Z');
  });

  it('throws the server sentence on a refused write', async () => {
    const { impl } = fakeFetch([
      json(smartFolder),
      json({ message: 'You do not have edit permission on this item' }, 403),
    ]);
    await expect(
      updateFolderChildren('f1', (ids) => [...ids, 'b'], impl),
    ).rejects.toThrow('You do not have edit permission on this item');
  });

  it('refuses to write into an item that is not a folder', async () => {
    const { calls, impl } = fakeFetch([json({ type: 'map', data: {} })]);
    await expect(
      updateFolderChildren('m1', (ids) => [...ids, 'b'], impl),
    ).rejects.toThrow('not a folder');
    expect(calls).toHaveLength(1);
  });
});

describe('withChildIds', () => {
  it('adds a version to data that has none', () => {
    expect(withChildIds(null, ['a'])).toEqual({ version: 1, childItemIds: ['a'] });
  });
});
