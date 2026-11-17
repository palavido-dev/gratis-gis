// SPDX-License-Identifier: AGPL-3.0-or-later
import { storePrintSnapshot } from './print-snapshot';

class FakeStorage {
  private m = new Map<string, string>();
  constructor(private quota = Infinity) {}
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    let used = v.length;
    for (const [key, val] of this.m) if (key !== k) used += val.length;
    if (used > this.quota) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
  keys(): string[] {
    return Array.from(this.m.keys());
  }
}

describe('storePrintSnapshot', () => {
  it('keeps only the newest snapshot so repeated prints fit the quota', () => {
    const s = new FakeStorage(1500);
    expect(storePrintSnapshot(s, 'print-snap-a-1', 'x'.repeat(1000))).toBe(true);
    expect(storePrintSnapshot(s, 'print-snap-a-2', 'x'.repeat(1000))).toBe(true);
    expect(storePrintSnapshot(s, 'print-snap-b-3', 'x'.repeat(1000))).toBe(true);
    expect(s.keys()).toEqual(['print-snap-b-3']);
  });

  it('leaves other keys alone', () => {
    const s = new FakeStorage();
    s.setItem('other', '1');
    storePrintSnapshot(s, 'print-snap-a-1', 'v');
    expect(s.keys().sort()).toEqual(['other', 'print-snap-a-1']);
  });

  it('reports a snapshot that cannot be stored', () => {
    const s = new FakeStorage(10);
    expect(storePrintSnapshot(s, 'print-snap-a-1', 'x'.repeat(100))).toBe(false);
  });
});
