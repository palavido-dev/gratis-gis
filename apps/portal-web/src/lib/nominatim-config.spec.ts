// SPDX-License-Identifier: AGPL-3.0-or-later
import { LOCAL_NOMINATIM, nominatimTarget } from './nominatim-config';

describe('nominatimTarget', () => {
  it('treats an empty NOMINATIM_URL from Compose as unset', () => {
    expect(nominatimTarget({ NOMINATIM_URL: '' })).toEqual({
      url: LOCAL_NOMINATIM,
      localDefault: true,
      allowPublic: true,
    });
  });

  it('never falls back to the public service for a configured host', () => {
    const target = nominatimTarget({ NOMINATIM_URL: 'http://nominatim:8080' });
    expect(target.url).toBe('http://nominatim:8080');
    expect(target.localDefault).toBe(false);
  });

  it('honours NOMINATIM_PUBLIC_FALLBACK=0', () => {
    expect(nominatimTarget({ NOMINATIM_PUBLIC_FALLBACK: '0' }).allowPublic).toBe(false);
    expect(nominatimTarget({ NOMINATIM_PUBLIC_FALLBACK: '' }).allowPublic).toBe(true);
  });
});
