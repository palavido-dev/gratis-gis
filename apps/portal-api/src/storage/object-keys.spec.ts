// SPDX-License-Identifier: AGPL-3.0-or-later
import { resetTenancyModeForTests } from '../common/tenancy.js';
import {
  ObjectKeyRefusedError,
  assertObjectOwner,
  keyOrgId,
  orgPrefix,
  parseObjectKey,
  samEmbedKeys,
  storageKey,
  systemOwner,
} from './object-keys.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const U = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';

const noLedger = async () => null;

function withMode(mode: 'single' | 'multi', fn: () => Promise<void>) {
  return async () => {
    const before = process.env.GRATIS_TENANCY;
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.GRATIS_TENANCY;
      else process.env.GRATIS_TENANCY = before;
      resetTenancyModeForTests();
    }
  };
}

describe('storageKey', () => {
  it('puts the kind first and the org second', () => {
    const key = storageKey('item-file', A);
    expect(key.startsWith(`item-file/o/${A}/`)).toBe(true);
    expect(parseObjectKey(key)).toMatchObject({ kind: 'item-file', orgId: A });
    expect(storageKey('map-icon', A, '.png').endsWith('.png')).toBe(true);
  });

  it('never collides: every key is new', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => storageKey('item-file', A)));
    expect(keys.size).toBe(1000);
  });

  it('refuses an org that is not a lowercase UUID, and an unknown kind', () => {
    expect(() => storageKey('item-file', A.toUpperCase())).toThrow(TypeError);
    expect(() => storageKey('item-file', '')).toThrow(TypeError);
    expect(() => storageKey('item-file', `${A}/..`)).toThrow(TypeError);
    expect(() => orgPrefix('not-a-kind' as never, A)).toThrow(TypeError);
  });
});

describe('parseObjectKey', () => {
  it('reads both layouts', () => {
    expect(parseObjectKey(`item-file/${U}`)).toEqual({ kind: 'item-file', orgId: null, rest: U });
    expect(parseObjectKey(`item-file/o/${A}/${U}`)).toEqual({ kind: 'item-file', orgId: A, rest: U });
    expect(parseObjectKey(`sam-embed/${U}/16/1/2.bin`)).toMatchObject({ orgId: null });
  });

  it.each([
    ['traversal', `item-file/o/${A}/../${U}`],
    ['dot segment', `item-file/./${U}`],
    ['empty segment', `item-file//${U}`],
    ['leading slash', `/item-file/${U}`],
    ['trailing slash', `item-file/${U}/`],
    ['encoded slash', `item-file%2F${U}`],
    ['encoded dots', `item-file/%2e%2e/${U}`],
    ['backslash', `item-file\\${U}`],
    ['kind in another case', `Item-File/${U}`],
    ['org marker in another case', `item-file/O/${A}/${U}`],
    ['org in upper case', `item-file/o/${A.toUpperCase()}/${U}`],
    ['org that is not a UUID', `item-file/o/not-an-org/${U}`],
    ['org with nothing after it', `item-file/o/${A}`],
    ['Cyrillic look-alike in kind', `item-filе/${U}`],
    ['full-width solidus', `item-file／${U}`],
    ['NUL byte', `item-file/${U}\u0000`],
    ['space', `item-file/ ${U}`],
    ['unknown kind', `backups/${U}`],
    ['kind alone', 'item-file'],
    ['too long', `item-file/${'a'.repeat(600)}`],
  ])('refuses %s', (_label, key) => {
    // An `O/` marker is not the org layout: it parses as an older key
    // whose rest starts with `O/`, which has no org and is handled by
    // the owner rules for older keys.
    const parsed = parseObjectKey(key);
    if (key.includes('/O/')) expect(parsed?.orgId ?? null).toBeNull();
    else expect(parsed).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(parseObjectKey(undefined)).toBeNull();
    expect(parseObjectKey(42)).toBeNull();
    expect(keyOrgId({})).toBeNull();
  });
});

describe('samEmbedKeys', () => {
  it('gives the org-prefixed key first and the older one second', () => {
    const [now, before] = samEmbedKeys(A, U, { z: 16, gx: 3, gy: 4 });
    expect(now).toBe(`sam-embed/o/${A}/${U}/16/3/4.bin`);
    expect(before).toBe(`sam-embed/${U}/16/3/4.bin`);
    expect(parseObjectKey(now)?.orgId).toBe(A);
  });
});

describe('assertObjectOwner', () => {
  const keyA = `item-file/o/${A}/${U}`;

  it(
    'passes the owning org and refuses every other org, in both modes',
    withMode('single', async () => {
      await expect(assertObjectOwner(keyA, { orgId: A }, noLedger)).resolves.toBeUndefined();
      await expect(assertObjectOwner(keyA, { orgId: B }, noLedger)).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    }),
  );

  it(
    'refuses another org in multi mode too, and answers 404',
    withMode('multi', async () => {
      const err = await assertObjectOwner(keyA, { orgId: B }, noLedger).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ObjectKeyRefusedError);
      expect((err as ObjectKeyRefusedError).getStatus()).toBe(404);
    }),
  );

  it(
    'refuses a malformed key for any org',
    withMode('single', async () => {
      for (const key of [`item-file/o/${A}/../x`, `item-file%2F${U}`, `item-filе/${U}`]) {
        await expect(assertObjectOwner(key, { orgId: A }, noLedger)).rejects.toBeInstanceOf(
          ObjectKeyRefusedError,
        );
      }
    }),
  );

  it(
    'lets system work through without a check',
    withMode('multi', async () => {
      await expect(assertObjectOwner('anything at all', systemOwner('test'), noLedger)).resolves.toBeUndefined();
    }),
  );

  it(
    'single mode: an older key belongs to the one org, with no ledger read',
    withMode('single', async () => {
      const ledger = jest.fn(async () => null);
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, ledger)).resolves.toBeUndefined();
      expect(ledger).not.toHaveBeenCalled();
    }),
  );

  it(
    'multi mode: an older key passes only for the org the ledger records',
    withMode('multi', async () => {
      const ledger = async () => A;
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, ledger)).resolves.toBeUndefined();
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: B }, ledger)).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
      // Unknown to the ledger: refused, never assumed to be the caller's.
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, noLedger)).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    }),
  );

  it(
    'a key of another kind is still checked by its org segment',
    withMode('multi', async () => {
      const shot = `feedback-screenshot/o/${A}/${U}`;
      await expect(assertObjectOwner(shot, { orgId: B }, noLedger)).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    }),
  );
});
