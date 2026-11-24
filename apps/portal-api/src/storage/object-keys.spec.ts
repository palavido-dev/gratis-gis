// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { resetTenancyModeForTests } from '../common/tenancy.js';
import {
  KIND_SUFFIXES,
  OBJECT_KINDS,
  ObjectKeyRefusedError,
  assertKeysMayBelongToOrg,
  assertObjectOwner,
  isKeyOfKind,
  keyMayBelongToOrg,
  keyOrgId,
  legacyKeyCounters,
  objectKeyInStoredUrl,
  orgPrefix,
  parseObjectKey,
  privatePathForBareUrl,
  publicUrlObject,
  samEmbedKeys,
  storageKey,
  suffixesOf,
  systemOwner,
  type LegacyOwnerLookup,
  type ObjectKind,
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

describe('shared key cases', () => {
  // The same file is read by the web mirror and the worker mirror, so
  // all three parsers agree on every case.
  const doc = JSON.parse(readFileSync(join(__dirname, 'object-key-cases.json'), 'utf8')) as {
    cases: Array<{ key: string; parsed: [string, string | null, string] | null }>;
  };

  it('parses every case as recorded', () => {
    expect(doc.cases.length).toBeGreaterThan(20);
    for (const c of doc.cases) {
      const got = parseObjectKey(c.key);
      const want = c.parsed ? { kind: c.parsed[0], orgId: c.parsed[1], rest: c.parsed[2] } : null;
      expect({ key: c.key, got }).toEqual({ key: c.key, got: want });
    }
  });
});

describe('suffixes per kind', () => {
  it('lets only map icons end in .png and analysis results in .geojson', () => {
    expect(storageKey('map-icon', A, '.png').endsWith('.png')).toBe(true);
    expect(storageKey('analysis-artifact', A, '.geojson').endsWith('.geojson')).toBe(true);
    expect(() => storageKey('item-file', A, '.png')).toThrow(TypeError);
    expect(() => storageKey('item-tile-layer', A, '.geojson')).toThrow(TypeError);
    expect(() => storageKey('map-icon', A, '.geojson')).toThrow(TypeError);
    for (const kind of OBJECT_KINDS) {
      expect(suffixesOf(kind as ObjectKind)).toContain('');
    }
    expect([...KIND_SUFFIXES.keys()].sort()).toEqual(['analysis-artifact', 'map-icon']);
  });
});

describe('kind and org helpers', () => {
  it('reads either layout through the parser', () => {
    expect(isKeyOfKind(`item-tile-layer/${U}`, 'item-tile-layer')).toBe(true);
    expect(isKeyOfKind(`item-tile-layer/o/${A}/${U}`, 'item-tile-layer')).toBe(true);
    expect(isKeyOfKind(`item-tile-layer/o/${A}/../${U}`, 'item-tile-layer')).toBe(false);
    expect(isKeyOfKind(`item-tile-layerx/${U}`, 'item-tile-layer')).toBe(false);
    expect(isKeyOfKind(`item-file/o/${A}/${U}`, 'item-tile-layer')).toBe(false);
    expect(isKeyOfKind(42, 'item-file')).toBe(false);
  });

  it('a key may belong to an org when it names that org or names none', () => {
    expect(keyMayBelongToOrg(`item-file/o/${A}/${U}`, A)).toBe(true);
    expect(keyMayBelongToOrg(`item-file/o/${A}/${U}`, B)).toBe(false);
    expect(keyMayBelongToOrg(`item-file/${U}`, B)).toBe(true);
    expect(keyMayBelongToOrg('not a key', A)).toBe(false);
  });

  it('refuses a job source that names another org, and passes older keys', () => {
    expect(() => assertKeysMayBelongToOrg([`item-tile-layer/o/${A}/${U}`, `item-tile-layer/${U}`, '', null], A)).not.toThrow();
    expect(() => assertKeysMayBelongToOrg([`item-tile-layer/o/${B}/${U}`], A)).toThrow(/not stored where/);
  });
});

describe('publicUrlObject', () => {
  const base = { publicBase: 'https://files.example.org/', bucket: 'gg' };
  const at = (rest: string) => `https://files.example.org/gg/${rest}`;

  it('reads one object of the kind in either layout', () => {
    expect(publicUrlObject(at(`user-avatar/${U}`), base, 'user-avatar')).toMatchObject({ orgId: null, key: `user-avatar/${U}` });
    expect(publicUrlObject(at(`user-avatar/o/${A}/${U}`), base, 'user-avatar')).toMatchObject({ orgId: A });
    expect(publicUrlObject(at(`user-avatar/${U}.png`), base, 'user-avatar')).not.toBeNull();
  });

  it('refuses another host, kind, nesting, traversal, encoding or query', () => {
    for (const url of [
      `https://other.example/gg/user-avatar/${U}`,
      at(`item-thumb/o/${A}/${U}`),
      at(`user-avatar/o/${A}/x/${U}`),
      at(`user-avatar/o/${A}/../${U}`),
      at(`user-avatar/o/${A}%2F${U}`),
      at(`user-avatar/${U}?x=1`),
      at(`user-avatar/${U}#x`),
      at('user-avatar/not-a-uuid'),
      at(`user-avatar/${U}${'a'.repeat(80)}`),
      at(`user-avatar/o/${A}`),
    ]) {
      expect({ url, got: publicUrlObject(url, base, 'user-avatar') }).toEqual({ url, got: null });
    }
  });
});

describe('objectKeyInStoredUrl', () => {
  it('finds the key under any host in either layout', () => {
    expect(objectKeyInStoredUrl(`http://old-host:9000/b/item-thumb/${U}`)).toBe(`item-thumb/${U}`);
    expect(objectKeyInStoredUrl(`https://cdn.example/b/group-thumb/o/${A}/${U}?v=2`)).toBe(`group-thumb/o/${A}/${U}`);
    expect(objectKeyInStoredUrl(`https://cdn.example/b/org-hero/o/${A}/../${U}`)).toBeNull();
    expect(objectKeyInStoredUrl('https://cdn.example/no-key-here.png')).toBeNull();
  });
});

describe('privatePathForBareUrl', () => {
  it('maps a bare bucket URL of a private object to its API path, both layouts', () => {
    expect(privatePathForBareUrl(`http://minio:9000/gratisgis/item-file/${U}`)).toBe(
      `/api/portal/storage/private/item-file/${U}`,
    );
    expect(privatePathForBareUrl(`https://files.example/b/feature-attachment/o/${A}/${U}`)).toBe(
      `/api/portal/storage/private/feature-attachment/o/${A}/${U}`,
    );
  });

  it('leaves public kinds, other shapes and non-URLs alone', () => {
    for (const v of [
      `https://files.example/b/item-thumb/${U}`,
      `https://files.example/b/item-file/${U}?x=1`,
      `https://files.example/b/item-file/o/${A}/x/${U}`,
      `https://files.example/b/item-file/o/${B.toUpperCase()}/${U}`,
      `https://files.example/item-file/${U}`,
      `ftp://files.example/b/item-file/${U}`,
      `/api/portal/storage/private/item-file/${U}`,
      'plain text',
    ]) {
      expect({ v, got: privatePathForBareUrl(v) }).toEqual({ v, got: null });
    }
  });
});

describe('older keys before and after the first ledger fill', () => {
  const lookup = (filled: boolean, org: string | null = null): LegacyOwnerLookup => ({
    orgOf: async () => org,
    ledgerFilled: async () => filled,
  });

  it(
    'multi mode, ledger not filled: a key with no row passes and is counted',
    withMode('multi', async () => {
      const before = legacyKeyCounters.passedBeforeFill;
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, lookup(false))).resolves.toBeUndefined();
      expect(legacyKeyCounters.passedBeforeFill).toBe(before + 1);
    }),
  );

  it(
    'multi mode, ledger not filled: a row for another org still refuses',
    withMode('multi', async () => {
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, lookup(false, B))).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    }),
  );

  it(
    'multi mode, ledger filled: a key with no row is refused, counted and logged at most once a minute',
    withMode('multi', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const before = legacyKeyCounters.refusedNoRow;
        for (let i = 0; i < 3; i += 1) {
          await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, lookup(true))).rejects.toBeInstanceOf(
            ObjectKeyRefusedError,
          );
        }
        expect(legacyKeyCounters.refusedNoRow).toBe(before + 3);
        const lines = warn.mock.calls.filter((c) => String(c[0]).includes('no usage ledger row'));
        expect(lines.length).toBeLessThanOrEqual(1);
      } finally {
        warn.mockRestore();
      }
    }),
  );

  it(
    'switches over as soon as the ledger reports filled',
    withMode('multi', async () => {
      let filled = false;
      const l: LegacyOwnerLookup = { orgOf: async () => null, ledgerFilled: async () => filled };
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, l)).resolves.toBeUndefined();
      filled = true;
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, l)).rejects.toBeInstanceOf(ObjectKeyRefusedError);
    }),
  );

  it(
    'single mode never reads the ledger, filled or not',
    withMode('single', async () => {
      const l = { orgOf: jest.fn(async () => null), ledgerFilled: jest.fn(async () => true) };
      await expect(assertObjectOwner(`item-file/${U}`, { orgId: A }, l)).resolves.toBeUndefined();
      expect(l.orgOf).not.toHaveBeenCalled();
      expect(l.ledgerFilled).not.toHaveBeenCalled();
    }),
  );

  it(
    'a new-layout key never depends on the fill',
    withMode('multi', async () => {
      await expect(assertObjectOwner(`item-file/o/${B}/${U}`, { orgId: A }, lookup(false))).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    }),
  );
});
