// SPDX-License-Identifier: AGPL-3.0-or-later
import { ogcBaseUrl, ogcRequestUrl } from './ogc-rest';

/**
 * A pasted OGC URL used to lose its whole query string, so a MapServer
 * `?map=` (which says which mapfile to serve) was gone from every
 * request and the service could not answer.
 */
describe('OGC request URLs', () => {
  it('keeps vendor parameters and drops the OGC request keys', () => {
    const base = ogcBaseUrl(
      'https://host/cgi-bin/mapserv?map=/srv/maps/parcels.map&SERVICE=WMS&request=GetCapabilities&Version=1.1.1',
    );
    expect(base).toBe('https://host/cgi-bin/mapserv?map=/srv/maps/parcels.map');
    expect(
      ogcRequestUrl(base, { service: 'WMS', request: 'GetCapabilities', version: '1.3.0' }),
    ).toBe(
      'https://host/cgi-bin/mapserv?map=/srv/maps/parcels.map&service=WMS&request=GetCapabilities&version=1.3.0',
    );
  });

  it('behaves as before on a URL with no vendor parameters', () => {
    const base = ogcBaseUrl(' https://host/geoserver/ows/?service=WFS ');
    expect(base).toBe('https://host/geoserver/ows');
    expect(ogcRequestUrl(base, { service: 'WFS', request: 'GetCapabilities' })).toBe(
      'https://host/geoserver/ows?service=WFS&request=GetCapabilities',
    );
  });

  it('drops a fragment and refuses an empty URL', () => {
    expect(ogcBaseUrl('https://host/wms?key=abc#top')).toBe('https://host/wms?key=abc');
    expect(() => ogcBaseUrl('  ')).toThrow('Service URL is required.');
  });
});
