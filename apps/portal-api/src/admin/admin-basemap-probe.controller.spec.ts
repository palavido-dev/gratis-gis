// SPDX-License-Identifier: AGPL-3.0-or-later
import { AdminBasemapProbeController } from './admin-basemap-probe.controller.js';

/**
 * Tests for the basemap probe controller. We don't mock the whole
 * NestJS layer here; the probe logic is HTTP-shaped (fetch a
 * remote URL, parse, return a result) but the interesting parts
 * are the XML-parser-driven WMTS + WMS handlers. We stub `fetch`
 * at the module level so the suite stays hermetic and we can
 * assert against real-world capabilities documents.
 *
 * `node:dns/promises.lookup` is also stubbed: the production
 * fetchWithTimeout routes through the SSRF guard which does a real
 * DNS lookup as a DNS-rebinding defense. The fake hostnames the
 * tests use (`old.example.org`, etc.) don't resolve, so we feed
 * the guard a fixed public IP for every lookup. The hostname-only
 * check still runs and still rejects `localhost` / private ranges.
 */
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '93.184.216.34', family: 4 })),
}));

type FetchStub = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  headers: { get: (k: string) => string | null };
}>;

const originalFetch = globalThis.fetch;

function stubFetch(map: Record<string, string | { status: number; body: string }>) {
  const stub: FetchStub = async (url) => {
    const entry = map[url];
    if (entry === undefined) {
      throw new Error(`Unstubbed fetch URL in test: ${url}`);
    }
    if (typeof entry === 'string') {
      return {
        ok: true,
        status: 200,
        text: async () => entry,
        json: async () => JSON.parse(entry),
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/xml' : null) },
      };
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => entry.body,
      json: async () => JSON.parse(entry.body),
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/xml' : null) },
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = stub;
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = originalFetch;
});

// ----------------------------------------------------------------
// WMTS
// ----------------------------------------------------------------

describe('AdminBasemapProbeController WMTS', () => {
  const controller = new AdminBasemapProbeController();

  it('extracts tile URL, title, attribution, and zoom range from a USGS-style WMTS capabilities document', async () => {
    const wmtsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0"
              xmlns:ows="http://www.opengis.net/ows/1.1"
              version="1.0.0">
  <ows:ServiceIdentification>
    <ows:Title>USGS National Map Topo</ows:Title>
    <ows:AccessConstraints>Public domain</ows:AccessConstraints>
  </ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>USGS Topo</ows:Title>
      <ows:Identifier>USGSTopo</ows:Identifier>
      <Style isDefault="true">
        <ows:Identifier>default</ows:Identifier>
      </Style>
      <Format>image/png</Format>
      <TileMatrixSetLink>
        <TileMatrixSet>GoogleMapsCompatible</TileMatrixSet>
      </TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
                   template="https://example.org/wmts/USGSTopo/default/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>GoogleMapsCompatible</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>1</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>2</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>3</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>4</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>5</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://example.org/wmts/1.0.0/WMTSCapabilities.xml': wmtsCaps,
    });

    const result = await controller.probe(
      'https://example.org/wmts/1.0.0/WMTSCapabilities.xml',
    );

    expect(result).toEqual({
      kind: 'tile-url',
      tileUrl:
        'https://example.org/wmts/USGSTopo/default/GoogleMapsCompatible/{z}/{y}/{x}.png',
      title: 'USGS National Map Topo',
      attribution: 'Public domain',
      minZoom: 0,
      maxZoom: 5,
    });
  });

  it('falls back to ProviderName when AccessConstraints is absent', async () => {
    const wmtsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <ows:ServiceIdentification><ows:Title>Test</ows:Title></ows:ServiceIdentification>
  <ows:ServiceProvider><ows:ProviderName>Acme Mapping</ows:ProviderName></ows:ServiceProvider>
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>W</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>W</ows:Identifier>
      <ows:SupportedCRS>EPSG:3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    const result = await controller.probe('https://x.org/wmts');
    expect(result.attribution).toBe('Acme Mapping');
  });

  it('refuses a TileMatrixSet whose SupportedCRS is not web mercator', async () => {
    const wmtsCaps = `<?xml version="1.0"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>WGS84</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>WGS84</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    await expect(controller.probe('https://x.org/wmts')).rejects.toThrow(
      /not web mercator/i,
    );
  });

  it('refuses a TileMatrixSet whose TileMatrix identifiers are not integers', async () => {
    const wmtsCaps = `<?xml version="1.0"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>W</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>W</ows:Identifier>
      <ows:SupportedCRS>EPSG:3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>GoogleMapsCompatible:0</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>GoogleMapsCompatible:1</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    await expect(controller.probe('https://x.org/wmts')).rejects.toThrow(
      /non-integer TileMatrix identifiers/i,
    );
  });

  it('refuses a layer that has only KVP tile URLs (no RESTful ResourceURL)', async () => {
    const wmtsCaps = `<?xml version="1.0"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>W</TileMatrixSet></TileMatrixSetLink>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>W</ows:Identifier>
      <ows:SupportedCRS>EPSG:3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    await expect(controller.probe('https://x.org/wmts')).rejects.toThrow(
      /no RESTful <ResourceURL/i,
    );
  });

  it('walks past unsupported layers to find a compatible one when both exist', async () => {
    // First layer references a 4326 TileMatrixSet; second layer
    // references a 3857 one. The probe should land on the second.
    const wmtsCaps = `<?xml version="1.0"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    <Layer>
      <ows:Identifier>WGS84Layer</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>WGS84</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/wgs84/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <Layer>
      <ows:Identifier>WebMercatorLayer</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <TileMatrixSetLink><TileMatrixSet>W</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/wm/{Style}/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>WGS84</ows:Identifier>
      <ows:SupportedCRS>EPSG:4326</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
    </TileMatrixSet>
    <TileMatrixSet>
      <ows:Identifier>W</ows:Identifier>
      <ows:SupportedCRS>EPSG:3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>2</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>3</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    const result = await controller.probe('https://x.org/wmts');
    expect(result.tileUrl).toBe('https://x/wm/default/{z}/{y}/{x}.png');
    expect(result.minZoom).toBe(2);
    expect(result.maxZoom).toBe(3);
  });

  it('accepts the EPSG:900913 alias as web mercator', async () => {
    const wmtsCaps = `<?xml version="1.0"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <TileMatrixSetLink><TileMatrixSet>OldGoogle</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://x/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>OldGoogle</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::900913</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://x.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    const result = await controller.probe('https://x.org/wmts');
    expect(result.kind).toBe('tile-url');
  });
});

// ----------------------------------------------------------------
// WMS
// ----------------------------------------------------------------

describe('AdminBasemapProbeController WMS', () => {
  const controller = new AdminBasemapProbeController();

  it('returns wms config for a 1.3.0 capabilities document with a web-mercator layer', async () => {
    const wmsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Service>
    <Title>Example WMS</Title>
    <AccessConstraints>None</AccessConstraints>
  </Service>
  <Capability>
    <Layer>
      <Title>Root</Title>
      <CRS>EPSG:3857</CRS>
      <CRS>EPSG:4326</CRS>
      <Layer queryable="1">
        <Name>topp:states</Name>
        <Title>USA States</Title>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    stubFetch({
      'https://example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        wmsCaps,
    });
    const result = await controller.probe('https://example.org/wms');
    expect(result).toEqual({
      kind: 'wms',
      wmsUrl: 'https://example.org/wms',
      wmsConfig: {
        layers: 'topp:states',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        crs: 'EPSG:3857',
      },
      title: 'Example WMS',
      attribution: 'None',
    });
  });

  it('reads SRS instead of CRS for WMS 1.1.1', async () => {
    const wmsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE WMT_MS_Capabilities SYSTEM "http://example.org/wms.dtd">
<WMT_MS_Capabilities version="1.1.1">
  <Service><Title>Old WMS</Title></Service>
  <Capability>
    <Layer>
      <SRS>EPSG:3857</SRS>
      <Layer queryable="1">
        <Name>old:layer</Name>
        <Title>Old layer</Title>
      </Layer>
    </Layer>
  </Capability>
</WMT_MS_Capabilities>`;
    stubFetch({
      'https://old.example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        wmsCaps,
    });
    const result = await controller.probe('https://old.example.org/wms');
    expect(result.wmsConfig?.layers).toBe('old:layer');
    expect(result.wmsConfig?.version).toBe('1.1.1');
  });

  it('refuses a server with no web-mercator layer', async () => {
    const wmsCaps = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0">
  <Service><Title>Only 4326</Title></Service>
  <Capability>
    <Layer>
      <CRS>EPSG:4326</CRS>
      <Layer queryable="1">
        <Name>only:wgs84</Name>
        <Title>Only WGS84</Title>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    stubFetch({
      'https://wgs.example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        wmsCaps,
    });
    await expect(controller.probe('https://wgs.example.org/wms')).rejects.toThrow(
      /EPSG:3857/,
    );
  });

  it('inherits parent CRS values when picking a leaf layer', async () => {
    // The child layer declares no CRS of its own; the parent
    // declares EPSG:3857. Per the WMS spec the child inherits,
    // so the probe should still pick the child.
    const wmsCaps = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0">
  <Service><Title>Inherited</Title></Service>
  <Capability>
    <Layer>
      <CRS>EPSG:3857</CRS>
      <Layer>
        <Title>Folder</Title>
        <Layer queryable="1">
          <Name>nested:layer</Name>
          <Title>Nested</Title>
        </Layer>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    stubFetch({
      'https://nest.example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        wmsCaps,
    });
    const result = await controller.probe('https://nest.example.org/wms');
    expect(result.wmsConfig?.layers).toBe('nested:layer');
  });

  it('rejects non-XML or non-WMS responses with a descriptive error', async () => {
    stubFetch({
      'https://broken.example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        '<?xml version="1.0"?><not_what_we_expect/>',
    });
    await expect(
      controller.probe('https://broken.example.org/wms'),
    ).rejects.toThrow(/not a WMS Capabilities document/i);
  });
});

// ----------------------------------------------------------------
// Detection / SSRF
// ----------------------------------------------------------------

describe('AdminBasemapProbeController URL handling', () => {
  const controller = new AdminBasemapProbeController();

  it('refuses private / loopback IPs', async () => {
    await expect(
      controller.probe('http://10.0.0.5/wmts?service=WMTS'),
    ).rejects.toThrow(/private \/ loopback/);
    await expect(
      controller.probe('http://192.168.1.10/wmts?service=WMTS'),
    ).rejects.toThrow(/private \/ loopback/);
    await expect(
      controller.probe('http://127.0.0.1/wmts?service=WMTS'),
    ).rejects.toThrow(/private \/ loopback/);
    await expect(
      controller.probe('http://localhost/wmts?service=WMTS'),
    ).rejects.toThrow(/private \/ loopback/);
  });

  it('short-circuits on XYZ tile templates without a network call', async () => {
    // No fetch stub installed; if probe attempts a network call
    // it will throw "Unstubbed fetch URL in test:"
    stubFetch({});
    const result = await controller.probe(
      'https://tile.example.org/foo/{z}/{x}/{y}.png',
    );
    expect(result).toEqual({
      kind: 'tile-url',
      tileUrl: 'https://tile.example.org/foo/{z}/{x}/{y}.png',
    });
  });

  it('returns 400 on missing url parameter', async () => {
    await expect(controller.probe(undefined)).rejects.toThrow(
      /Missing url parameter/,
    );
  });

  it('returns 400 on malformed url', async () => {
    await expect(controller.probe('not a url')).rejects.toThrow(
      /Not a valid URL/,
    );
  });
});

// ----------------------------------------------------------------
// Discovered attribution is untrusted third-party content
// ----------------------------------------------------------------

/**
 * The attribution this endpoint returns is lifted verbatim out of a
 * document some other organization's server wrote. The basemap editor
 * drops it straight into its form state and saves it onto the item,
 * where MapLibre later renders it as HTML through a sanitizer that is
 * bypassable on the version we are pinned to. So the probe result has
 * to be clean before it leaves the API, on every branch that can
 * produce one.
 */
describe('AdminBasemapProbeController attribution sanitizing', () => {
  const controller = new AdminBasemapProbeController();

  const PAYLOAD = '<img src=x onerror=alert(1)>Public domain';

  it('sanitizes an attribution discovered from a WMS capabilities document', async () => {
    const wmsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Service>
    <Title>Hostile WMS</Title>
    <AccessConstraints><![CDATA[${PAYLOAD}]]></AccessConstraints>
  </Service>
  <Capability>
    <Layer>
      <CRS>EPSG:3857</CRS>
      <Layer queryable="1"><Name>x:y</Name></Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
    stubFetch({
      'https://hostile.example.org/wms?service=WMS&request=GetCapabilities&version=1.3.0':
        wmsCaps,
    });
    const result = await controller.probe('https://hostile.example.org/wms');
    expect(result.attribution).toBeDefined();
    expect(result.attribution).not.toContain('<img');
    expect(result.attribution).toContain('&lt;img');
  });

  it('sanitizes an attribution discovered from a WMTS capabilities document', async () => {
    const wmtsCaps = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <ows:ServiceIdentification>
    <ows:Title>Hostile WMTS</ows:Title>
    <ows:AccessConstraints><![CDATA[${PAYLOAD}]]></ows:AccessConstraints>
  </ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Identifier>L</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile"
        template="https://hostile.example.org/t/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet>
      <ows:Identifier>GoogleMapsCompatible</ows:Identifier>
      <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix>
      <TileMatrix><ows:Identifier>1</ows:Identifier></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;
    stubFetch({
      'https://hostile.example.org/wmts?service=WMTS&request=GetCapabilities&version=1.0.0':
        wmtsCaps,
    });
    const result = await controller.probe('https://hostile.example.org/wmts');
    expect(result.attribution).toBeDefined();
    expect(result.attribution).not.toContain('<img');
    expect(result.attribution).toContain('&lt;img');
  });

  it('sanitizes copyrightText discovered from an ArcGIS MapServer', async () => {
    stubFetch({
      'https://hostile.example.org/rest/services/X/MapServer?f=json':
        JSON.stringify({
          mapName: 'X',
          copyrightText: '<a href="javascript:alert(1)">County GIS</a>',
          singleFusedMapCache: true,
        }),
    });
    const result = await controller.probe(
      'https://hostile.example.org/rest/services/X/MapServer',
    );
    expect(result.attribution).toBeDefined();
    expect(result.attribution).not.toMatch(/<a\s/);
    expect(result.attribution).toContain('County GIS');
  });

  it('leaves a benign discovered attribution with a real link intact', async () => {
    stubFetch({
      'https://good.example.org/rest/services/X/MapServer?f=json':
        JSON.stringify({
          mapName: 'X',
          copyrightText:
            '<a href="https://good.example.org/terms">County GIS</a>',
          singleFusedMapCache: true,
        }),
    });
    const result = await controller.probe(
      'https://good.example.org/rest/services/X/MapServer',
    );
    expect(result.attribution).toBe(
      '<a href="https://good.example.org/terms" target="_blank" ' +
        'rel="noopener noreferrer">County GIS</a>',
    );
  });

  it('does not invent an attribution key when the document has none', async () => {
    stubFetch({});
    const result = await controller.probe(
      'https://tile.example.org/{z}/{x}/{y}.png',
    );
    expect('attribution' in result).toBe(false);
  });
});
