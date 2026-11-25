// SPDX-License-Identifier: AGPL-3.0-or-later
import { runAsOrg } from '../common/tenant-context.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import {
  acquireIngestSlot,
  assertIngestDiskRoom,
  IngestBusyException,
  IngestDiskException,
  resetIngestSlotsForTests,
} from './ingest-slots.js';

describe('ingest slots', () => {
  afterEach(() => {
    resetIngestSlotsForTests();
  });

  it('gives one user a single slot and a second user the other', () => {
    const releaseA = acquireIngestSlot('a');
    const releaseB = acquireIngestSlot('b');
    expect(() => acquireIngestSlot('c')).toThrow(IngestBusyException);
    releaseA();
    const releaseC = acquireIngestSlot('c');
    releaseB();
    releaseC();
  });

  it('does not let one user hold both slots', () => {
    const release = acquireIngestSlot('a');
    expect(() => acquireIngestSlot('a')).toThrow(IngestBusyException);
    release();
    expect(() => acquireIngestSlot('a')).not.toThrow();
  });

  describe.each(['single', 'multi'] as const)('%s tenancy', (mode) => {
    const before = process.env.GRATIS_TENANCY;
    beforeEach(() => {
      if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
      else delete process.env.GRATIS_TENANCY;
      resetTenancyModeForTests();
    });
    afterEach(() => {
      if (before === undefined) delete process.env.GRATIS_TENANCY;
      else process.env.GRATIS_TENANCY = before;
      resetTenancyModeForTests();
    });

    it('one overall limit, whichever organization asks', () => {
      const r1 = runAsOrg('org-a', () => acquireIngestSlot('a1'));
      const r2 = runAsOrg('org-a', () => acquireIngestSlot('a2'));
      expect(() => runAsOrg('org-b', () => acquireIngestSlot('b1'))).toThrow(IngestBusyException);
      r1();
      // A freed slot goes to whoever asks first.
      const r3 = runAsOrg('org-a', () => acquireIngestSlot('a3'));
      r2();
      r3();
    });
  });

  it('refuses when the filesystem cannot hold the file plus headroom', () => {
    expect(() => assertIngestDiskRoom(100, 100)).toThrow(IngestDiskException);
    expect(() => assertIngestDiskRoom(10, 256 * 1024 * 1024 + 10)).not.toThrow();
  });
});