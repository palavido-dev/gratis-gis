// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { portalJson } from './portal-json';

afterEach(() => jest.restoreAllMocks());

describe('portalJson', () => {
  it('throws the server sentence, not the raw body', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ statusCode: 400, message: ['title must be shorter'], error: 'Bad Request' }),
        { status: 400 },
      ),
    );
    await expect(portalJson('/api/portal/x')).rejects.toThrow(/title must be shorter/);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>' + 'x'.repeat(2000) + '</html>', { status: 502 }),
    );
    await expect(portalJson('/api/portal/x')).rejects.toThrow(/502/);
    await expect(portalJson('/api/portal/x')).rejects.not.toThrow(/<html>/);
  });

  it('returns undefined for an empty body', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(portalJson('/api/portal/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('error banners', () => {
  // `${res.status} ${await res.text()}` put raw JSON or an HTML 502
  // page on screen. Failures go through lib/api-error.ts instead.
  it('never interpolate a raw response body', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && !n.endsWith('.spec.ts')) files.push(p);
      }
    };
    walk(root);
    const hits = files.filter((f) =>
      /\$\{await \w+\.text\(\)/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });
});

describe('form designer paired-layer sync', () => {
  it('reads the failure body once', () => {
    const src = readFileSync(
      join(__dirname, '..', 'app', 'items', '[id]', 'form', 'designer.tsx'),
      'utf8',
    );
    expect(src).toContain("parseApiError(res, 'Layer schema patch failed')");
    expect(src).not.toMatch(/res\.ok \? 'ok' : await res\.text\(\)/);
  });
});
