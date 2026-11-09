// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUuid, uuidv7, uuidv7Timestamp } from '@gratis-gis/engine';

describe('uuidv7', () => {
  it('is strictly increasing within a process, even inside one millisecond', () => {
    // Thousands of ids land in the same millisecond. Lowercase hex
    // string order is the same as Postgres's byte order for uuid.
    const ids = Array.from({ length: 20_000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the version and variant bits', () => {
    for (let i = 0; i < 1000; i += 1) {
      const id = uuidv7();
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('encodes the current time, and uses an explicit timestamp as given', () => {
    const before = Date.now();
    const ts = uuidv7Timestamp(uuidv7())!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1);
    expect(uuidv7Timestamp(uuidv7(1_700_000_000_000))).toBe(1_700_000_000_000);
  });
});
