// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseManualPoint } from './form-coordinates';

describe('parseManualPoint', () => {
  it('needs both coordinates', () => {
    expect(parseManualPoint('34.05', '')).toBeNull();
    expect(parseManualPoint('', '-117.19')).toBeNull();
    expect(parseManualPoint('34.05', '-117.19')).toEqual({ lat: 34.05, lng: -117.19 });
  });

  it('treats a half-typed or out-of-range value as no point', () => {
    expect(parseManualPoint('34', '-')).toBeNull();
    expect(parseManualPoint('91', '0')).toBeNull();
    expect(parseManualPoint('0', '181')).toBeNull();
  });
});
