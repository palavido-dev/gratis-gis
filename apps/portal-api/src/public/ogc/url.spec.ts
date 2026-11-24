// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

import { OGC_LIST_PATHS, absoluteBase, withOrgLinks, withOrgParam } from './url.js';

const req = (headers: Record<string, string>): Request =>
  ({ headers, protocol: 'https' }) as unknown as Request;

describe('absoluteBase (OGC self-links must not follow a forged Host)', () => {
  const saved = process.env.PORTAL_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = saved;
  });

  it('uses PORTAL_BASE_URL and ignores a spoofed X-Forwarded-Host', () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    const base = absoluteBase(
      req({ 'x-forwarded-host': 'evil.example', host: 'evil.example' }),
    );
    // Not evil.example: a forged host cannot redirect an OGC client
    // following the links this base builds.
    expect(base).toBe('https://gratisgis.org');
  });

  it('strips a trailing slash from the configured base', () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org/';
    expect(absoluteBase(req({}))).toBe('https://gratisgis.org');
  });

  it('falls back to request headers only when the env var is unset (dev)', () => {
    delete process.env.PORTAL_BASE_URL;
    expect(absoluteBase(req({ host: 'localhost:4000' }))).toBe(
      'https://localhost:4000',
    );
  });
});

describe('withOrgParam / withOrgLinks (links stay in the named org)', () => {
  it('adds org to a link once, and nothing without a slug', () => {
    expect(withOrgParam('https://p.test/api/public/ogc/records?limit=10', 'a')).toBe(
      'https://p.test/api/public/ogc/records?limit=10&org=a',
    );
    expect(withOrgParam('https://p.test/api/public/ogc/records?org=b', 'a')).toBe(
      'https://p.test/api/public/ogc/records?org=b',
    );
    expect(withOrgParam('https://p.test/x', undefined)).toBe('https://p.test/x');
  });

  it('marks list links and leaves single-item links alone', () => {
    const doc = {
      links: [
        { href: 'https://p.test/api/public/ogc/', rel: 'self' },
        { href: 'https://p.test/api/public/ogc/records?offset=10', rel: 'next' },
        { href: 'https://p.test/api/public/ogc/conformance', rel: 'conformance' },
      ],
      features: [
        {
          links: [
            { href: 'https://p.test/api/public/ogc/records/abc', rel: 'self' },
            { href: 'https://p.test/api/public/ogc/collections/abc/items', rel: 'items' },
          ],
        },
      ],
    };
    withOrgLinks(doc, 'a b', OGC_LIST_PATHS);
    expect(doc.links.map((l) => l.href)).toEqual([
      'https://p.test/api/public/ogc/?org=a+b',
      'https://p.test/api/public/ogc/records?offset=10&org=a+b',
      'https://p.test/api/public/ogc/conformance',
    ]);
    expect(doc.features[0]!.links.map((l) => l.href)).toEqual([
      'https://p.test/api/public/ogc/records/abc',
      'https://p.test/api/public/ogc/collections/abc/items',
    ]);
  });

  it('returns the document unchanged with no slug', () => {
    const doc = { links: [{ href: 'https://p.test/api/public/ogc/records' }] };
    expect(withOrgLinks(doc, undefined, OGC_LIST_PATHS)).toEqual({
      links: [{ href: 'https://p.test/api/public/ogc/records' }],
    });
  });
});
