// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * OGC capabilities parsing (54-3, 54-4). The node test environment has
 * no DOMParser, so @xmldom/xmldom stands in; it implements the same
 * namespace-aware lookups the browser does.
 */
import { DOMParser } from '@xmldom/xmldom';

import { parseWfsCapabilities, parseWmsCapabilities } from './ogc-rest';
import { parseWmtsCapabilities, requestedOgcService } from './service-probe';

const xml = (text: string) =>
  new DOMParser().parseFromString(text, 'application/xml') as unknown as Document;

describe('capabilities root check', () => {
  it('refuses an exception report as WMS or WFS', () => {
    const doc = xml('<ServiceExceptionReport version="1.3.0"><ServiceException>no</ServiceException></ServiceExceptionReport>');
    expect(() => parseWmsCapabilities('https://h/ows', doc)).toThrow(/Not WMS/);
    expect(() => parseWfsCapabilities('https://h/ows', doc)).toThrow(/Not WFS/);
  });

  it('refuses WFS capabilities as WMS', () => {
    const doc = xml('<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0"/>');
    expect(() => parseWmsCapabilities('https://h/ows', doc)).toThrow(/Not WMS/);
  });

  it('refuses a document with no Contents as WMTS', () => {
    const doc = xml('<Capabilities version="1.0.0"><Layer/></Capabilities>');
    expect(() => parseWmtsCapabilities('https://h/wmts', doc)).toThrow(/Not WMTS/);
  });
});

describe('namespace-prefixed elements', () => {
  it('finds prefixed WFS feature types and OWS corners', () => {
    const doc = xml(`
      <wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0"
          xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
        <ows:ServiceIdentification><ows:Title>Parcels</ows:Title></ows:ServiceIdentification>
        <wfs:FeatureTypeList>
          <wfs:FeatureType>
            <wfs:Name>ns:parcels</wfs:Name>
            <wfs:Title>Parcels</wfs:Title>
            <ows:WGS84BoundingBox>
              <ows:LowerCorner>-120 34</ows:LowerCorner>
              <ows:UpperCorner>-119 35</ows:UpperCorner>
            </ows:WGS84BoundingBox>
          </wfs:FeatureType>
        </wfs:FeatureTypeList>
      </wfs:WFS_Capabilities>`);
    const caps = parseWfsCapabilities('https://h/ows', doc);
    expect(caps.title).toBe('Parcels');
    expect(caps.layers).toEqual([
      { name: 'ns:parcels', title: 'Parcels', bbox: [-120, 34, -119, 35] },
    ]);
    expect(caps.bbox).toEqual([-120, 34, -119, 35]);
  });

  it('reads a WMTS title and layer bbox written with the ows prefix', () => {
    const doc = xml(`
      <Capabilities xmlns="http://www.opengis.net/wmts/1.0"
          xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
        <ows:ServiceIdentification><ows:Title>Tiles</ows:Title></ows:ServiceIdentification>
        <Contents>
          <Layer>
            <ows:Title>Roads</ows:Title>
            <ows:Identifier>roads</ows:Identifier>
            <ows:WGS84BoundingBox>
              <ows:LowerCorner>1 2</ows:LowerCorner>
              <ows:UpperCorner>3 4</ows:UpperCorner>
            </ows:WGS84BoundingBox>
          </Layer>
        </Contents>
      </Capabilities>`);
    const data = parseWmtsCapabilities('https://h/wmts', doc);
    expect(data.serviceTitle).toBe('Tiles');
    expect(data.layers?.[0]).toMatchObject({ name: 'roads', title: 'Roads', bbox: [1, 2, 3, 4] });
  });
});

describe('requestedOgcService', () => {
  it('reads service= from a pasted GetCapabilities URL, any case', () => {
    expect(requestedOgcService('https://h/ows?service=WFS&request=GetCapabilities')).toBe('WFS');
    expect(requestedOgcService('https://h/ows?SERVICE=wms')).toBe('WMS');
    expect(requestedOgcService('https://h/ows?map=/a.map')).toBeNull();
    expect(requestedOgcService('https://h/ows')).toBeNull();
  });
});
