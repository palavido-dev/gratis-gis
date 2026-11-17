// SPDX-License-Identifier: AGPL-3.0-or-later
import { trashRetentionDays } from './trash-retention.js';

describe('trashRetentionDays', () => {
  it('defaults to 30 and reads the operator setting', () => {
    expect(trashRetentionDays(undefined)).toBe(30);
    expect(trashRetentionDays('')).toBe(30);
    expect(trashRetentionDays('7')).toBe(7);
  });

  it('is null for a value the purge job would refuse', () => {
    expect(trashRetentionDays('0')).toBeNull();
    expect(trashRetentionDays('soon')).toBeNull();
  });
});
