// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { GeocodingService } from './geocoding.service.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '203.0.113.10', family: 4 })),
}));

/**
 * Upstream ArcGIS GeocodeServer calls: the URL the probe and the
 * search build, the timeout they pass, and settings stored with the
 * wrong type.
 */
describe('external ArcGIS geocoder', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit | undefined }>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('findAddressCandidates')) {
        return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ currentVersion: 11.1 }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function service(data: Record<string, unknown> = {}) {
    const item = {
      id: 'geo',
      type: 'geocoding_service',
      data: {
        version: 1,
        mode: 'external-arcgis',
        sourceLayerId: '',
        searchFields: [],
        externalUrl: 'https://geo.example.com/arcgis/rest/services/X/GeocodeServer?f=pjson',
        ...data,
      },
    };
    return new GeocodingService(
      {} as never,
      { get: async () => item } as never,
      {} as never,
    );
  }

  it('probes the service root, not the pasted query string', async () => {
    const out = await service().probeExternalArcgis(
      'https://geo.example.com/arcgis/rest/services/X/GeocodeServer/?f=pjson#x',
    );
    expect(out.externalUrl).toBe('https://geo.example.com/arcgis/rest/services/X/GeocodeServer');
    expect(calls[0]!.url).toBe(
      'https://geo.example.com/arcgis/rest/services/X/GeocodeServer?f=json',
    );
  });

  it('passes a timeout that also covers the body read', async () => {
    await service().probeExternalArcgis(
      'https://geo.example.com/arcgis/rest/services/X/GeocodeServer',
    );
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns an upstream that is not JSON into a 400', async () => {
    globalThis.fetch = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(
      service().probeExternalArcgis('https://geo.example.com/arcgis/rest/services/X/GeocodeServer'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('searches the stored root even when the stored URL kept a query', async () => {
    await service().search({} as never, 'geo', '1 Main St');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/arcgis/rest/services/X/GeocodeServer/findAddressCandidates');
    expect(url.searchParams.get('f')).toBe('json');
  });

  it('uses defaults when a number setting was saved as text', async () => {
    await service({ candidateLimit: 'ten', minScore: 'x' }).search({} as never, 'geo', 'Main');
    expect(new URL(calls[0]!.url).searchParams.get('maxLocations')).toBe('10');
  });
});
