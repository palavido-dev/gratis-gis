// SPDX-License-Identifier: AGPL-3.0-or-later
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

  it('refuses when the filesystem cannot hold the file plus headroom', () => {
    expect(() => assertIngestDiskRoom(100, 100)).toThrow(IngestDiskException);
    expect(() => assertIngestDiskRoom(10, 256 * 1024 * 1024 + 10)).not.toThrow();
  });
});