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

  describe('per organization', () => {
    const before = process.env.GRATIS_TENANCY;
    afterEach(() => {
      if (before === undefined) delete process.env.GRATIS_TENANCY;
      else process.env.GRATIS_TENANCY = before;
      resetTenancyModeForTests();
    });

    it('one organization: two of its users may hold both slots, as before', () => {
      delete process.env.GRATIS_TENANCY;
      resetTenancyModeForTests();
      const r1 = runAsOrg('org-a', () => acquireIngestSlot('a1'));
      const r2 = runAsOrg('org-a', () => acquireIngestSlot('a2'));
      r1();
      r2();
    });

    it('many organizations: one organization holds at most one slot, and another still gets one', () => {
      process.env.GRATIS_TENANCY = 'multi';
      resetTenancyModeForTests();
      const r1 = runAsOrg('org-a', () => acquireIngestSlot('a1'));
      expect(() => runAsOrg('org-a', () => acquireIngestSlot('a2'))).toThrow(IngestBusyException);
      const r2 = runAsOrg('org-b', () => acquireIngestSlot('b1'));
      r1();
      expect(() => runAsOrg('org-a', () => acquireIngestSlot('a2'))).not.toThrow();
      r2();
    });
  });

  it('refuses when the filesystem cannot hold the file plus headroom', () => {
    expect(() => assertIngestDiskRoom(100, 100)).toThrow(IngestDiskException);
    expect(() => assertIngestDiskRoom(10, 256 * 1024 * 1024 + 10)).not.toThrow();
  });
});