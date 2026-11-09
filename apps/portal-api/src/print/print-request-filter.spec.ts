// SPDX-License-Identifier: AGPL-3.0-or-later
import { createPrintRequestFilter } from './print-request-filter.js';

describe('print renderer request filter', () => {
  // A stand-in for the private-address check, so the spec needs no DNS.
  const check = async (url: string) => {
    const host = new URL(url).hostname;
    if (['minio', 'keycloak', '169.254.169.254', '10.0.0.5'].includes(host)) {
      throw new Error('private');
    }
  };
  const allowed = createPrintRequestFilter(
    ['http://portal-web:3000', 'https://gratisgis.org', undefined],
    check,
  );

  it('lets the preview page and the portal through', async () => {
    await expect(allowed('http://portal-web:3000/print-preview/x')).resolves.toBe(true);
    await expect(allowed('https://gratisgis.org/api/portal/items/1')).resolves.toBe(true);
  });

  it('lets public tiles and images through', async () => {
    await expect(allowed('https://tile.openstreetmap.org/1/0/0.png')).resolves.toBe(true);
  });

  it('keeps in-browser URLs', async () => {
    await expect(allowed('data:image/png;base64,AAAA')).resolves.toBe(true);
    await expect(allowed('blob:http://portal-web:3000/abc')).resolves.toBe(true);
  });

  it('blocks internal hosts a template could name', async () => {
    await expect(allowed('http://minio:9000/bucket/key')).resolves.toBe(false);
    await expect(allowed('http://keycloak:8080/realms/x')).resolves.toBe(false);
    await expect(allowed('http://169.254.169.254/latest/meta-data/')).resolves.toBe(false);
    await expect(allowed('file:///etc/passwd')).resolves.toBe(false);
  });

  it('applies the real private-address check by default', async () => {
    const real = createPrintRequestFilter(['http://portal-web:3000']);
    await expect(real('http://127.0.0.1:5432/')).resolves.toBe(false);
    await expect(real('http://169.254.169.254/')).resolves.toBe(false);
  });
});
