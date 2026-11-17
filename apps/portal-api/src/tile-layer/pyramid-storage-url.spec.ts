// SPDX-License-Identifier: AGPL-3.0-or-later
import { isOwnStorageUrl, storageBasesFromEnv } from './pyramid-storage-url.js';

const bases = ['http://minio:9000', 'http://192.168.1.20:8900'];

describe('isOwnStorageUrl', () => {
  it('allows this install\'s storage hosts', () => {
    expect(isOwnStorageUrl('http://minio:9000/gratisgis/item-tile-layer/abc', bases)).toBe(
      true,
    );
    expect(
      isOwnStorageUrl('http://192.168.1.20:8900/gratisgis/item-tile-layer/abc', bases),
    ).toBe(true);
  });

  it('refuses other hosts, relative paths, and embedded credentials', () => {
    expect(isOwnStorageUrl('http://169.254.169.254/latest/', bases)).toBe(false);
    expect(isOwnStorageUrl('http://keycloak:8080/admin', bases)).toBe(false);
    expect(isOwnStorageUrl('/api/portal/storage/private/x', bases)).toBe(false);
    expect(isOwnStorageUrl('http://user:pass@minio:9000/x', bases)).toBe(false);
    expect(isOwnStorageUrl('http://minio:9000/x', [])).toBe(false);
  });
});

describe('storageBasesFromEnv', () => {
  it('reads the configured endpoints and skips blanks', () => {
    expect(
      storageBasesFromEnv({
        MINIO_ENDPOINT: 'http://minio:9000',
        MINIO_PUBLIC_BASE: '',
        S3_ENDPOINT: ' http://192.168.1.20:8900 ',
      }),
    ).toEqual(['http://minio:9000', 'http://192.168.1.20:8900']);
  });
});
