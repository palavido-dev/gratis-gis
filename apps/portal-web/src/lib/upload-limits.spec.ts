// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('image upload size cap', () => {
  // The asset picker defaulted to 10 MB while presign refused anything
  // over 5 MB, so 5 to 10 MB images passed the early check and then
  // failed. Both clients and the server read one constant now.
  it.each([
    ['components/asset-picker.tsx', /maxMb = IMAGE_UPLOAD_MAX_MB/],
    ['components/image-uploader.tsx', /MAX_MB = IMAGE_UPLOAD_MAX_MB/],
  ])('%s uses the shared cap', (file, pattern) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).toMatch(pattern);
  });

  it('matches what portal-api enforces', () => {
    const api = readFileSync(
      join(__dirname, '..', '..', '..', 'portal-api', 'src', 'storage', 'storage.service.ts'),
      'utf8',
    );
    expect(api).toMatch(/const MAX_UPLOAD_BYTES = IMAGE_UPLOAD_MAX_BYTES;/);
  });
});
