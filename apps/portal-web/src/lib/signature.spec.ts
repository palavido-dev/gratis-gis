// SPDX-License-Identifier: AGPL-3.0-or-later
import { dataUrlBytes, pendingSignature, signatureSrc } from './signature';

const png = 'data:image/png;base64,iVBORw0KGgo=';

describe('signatureSrc', () => {
  it('reads an uploaded answer by its url', () => {
    expect(
      signatureSrc([{ name: 's', mimeType: 'image/png', sizeBytes: 1, url: '/u', key: 'k' }]),
    ).toBe('/u');
  });

  it('reads a pending answer by its data URL', () => {
    expect(signatureSrc(pendingSignature(png))).toBe(png);
  });

  it('prefers the uploaded url when both are present', () => {
    expect(
      signatureSrc([{ name: 's', mimeType: 'image/png', sizeBytes: 1, url: '/u', dataUrl: png }]),
    ).toBe('/u');
  });

  it('tolerates a legacy bare data URL', () => {
    expect(signatureSrc(png)).toBe(png);
  });

  it('is null for no answer or something else', () => {
    expect(signatureSrc(null)).toBeNull();
    expect(signatureSrc([])).toBeNull();
    expect(signatureSrc('my name')).toBeNull();
    expect(signatureSrc([{ name: 's' }])).toBeNull();
  });
});

describe('dataUrlBytes', () => {
  it('counts the decoded payload, minus padding', () => {
    // "iVBORw0KGgo=" is 12 base64 chars with one pad: 8 bytes.
    expect(dataUrlBytes(png)).toBe(8);
    expect(dataUrlBytes('data:image/png;base64,QQ==')).toBe(1);
    expect(dataUrlBytes('data:image/png;base64,')).toBe(0);
  });
});

describe('pendingSignature', () => {
  it('is one PNG attachment carrying the data URL', () => {
    expect(pendingSignature(png)).toEqual([
      { name: 'signature.png', mimeType: 'image/png', sizeBytes: 8, dataUrl: png },
    ]);
  });
});
