// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A page left running an old build must not block the next build's
 * schema upgrade. Every connection the page modules hold has to close
 * on versionchange, and per-call connections have to close when their
 * transaction ends.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { queueSubmission, resetFormOfflineDbForTests } from './form-offline';
import {
  OFFLINE_DB_NAME,
  getOfflineIdentity,
  openOfflineDb,
} from './offline-store';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetFormOfflineDbForTests();
});

/** Open `name` one version above `current`, as a newer build would. */
function upgrade(name: string, current: number): Promise<'opened' | 'blocked'> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, current + 1);
    let blocked = false;
    req.onblocked = () => {
      blocked = true;
    };
    req.onsuccess = () => {
      req.result.close();
      resolve(blocked ? 'blocked' : 'opened');
    };
    req.onerror = () => reject(req.error);
  });
}

describe('offline database connections', () => {
  it('closes the per-call connection when its transaction ends', async () => {
    await getOfflineIdentity();
    const db = await openOfflineDb();
    const version = db.version;
    db.close();
    await expect(upgrade(OFFLINE_DB_NAME, version)).resolves.toBe('opened');
  });

  it('gives way to a newer version from a held connection', async () => {
    const held = await openOfflineDb();
    await expect(upgrade(OFFLINE_DB_NAME, held.version)).resolves.toBe('opened');
  });

  it('closes the cached form outbox connection on versionchange', async () => {
    await queueSubmission({
      formId: 'f',
      schemaVersion: 1,
      response: {},
      ownerUserId: null,
    });
    await expect(upgrade('gratisgis-forms', 1)).resolves.toBe('opened');
  });
});
