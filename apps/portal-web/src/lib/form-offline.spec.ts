// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The form outbox follows the feature queue's ownership rules: a
 * response is listed and sent only under the account that captured
 * it, counts toward that account's sign-out warning, and shows up as
 * another account's data after a switch. Before this, A's offline
 * answers on a shared tablet were posted under B's session.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  countForeignSubmissions,
  countUnsentSubmissions,
  drain,
  listQueued,
  markSent,
  queueSubmission,
  removeForeignSubmissions,
  resetFormOfflineDbForTests,
} from './form-offline';
import {
  countUnsyncedEdits,
  describeForeignOfflineData,
  removeForeignOfflineData,
} from './offline-store';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetFormOfflineDbForTests();
});

async function capture(owner: string | null, formId = 'form-1') {
  return queueSubmission({
    formId,
    schemaVersion: 1,
    response: { q1: owner ?? 'anon' },
    ownerUserId: owner,
  });
}

describe('form outbox ownership', () => {
  it('stamps the capturing account', async () => {
    const row = await capture('alice');
    expect(row.ownerUserId).toBe('alice');
    const anon = await capture(null);
    expect(anon.ownerUserId).toBeUndefined();
  });

  it("never sends one account's responses under another's session", async () => {
    await capture('alice');
    await capture('bob');
    const sentFor: string[] = [];
    const result = await drain('form-1', 'bob', async (row) => {
      sentFor.push(String(row.response.q1));
    });
    expect(sentFor).toEqual(['bob']);
    expect(result).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect((await listQueued('bob')).map((r) => r.response.q1)).toEqual(['bob']);
  });

  it('sends nothing owned while nobody is signed in', async () => {
    await capture('alice');
    const send = jest.fn(async () => {});
    await drain('form-1', null, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('counts unsent responses toward the owner only', async () => {
    const a = await capture('alice');
    await capture('alice');
    await capture('bob');
    await markSent(a.clientId);
    expect(await countUnsentSubmissions('alice')).toBe(1);
    expect(await countForeignSubmissions('alice')).toBe(1);
    expect(await countForeignSubmissions('bob')).toBe(1);
  });

  it('removes only the rows of the other account', async () => {
    await capture('alice');
    await capture('bob');
    expect(await removeForeignSubmissions('bob')).toBe(1);
    expect(await countForeignSubmissions('bob')).toBe(0);
    expect(await countUnsentSubmissions('bob')).toBe(1);
  });
});

describe('offline-store includes the form outbox', () => {
  it('warns at sign-out about unsent responses', async () => {
    await capture('alice');
    expect(await countUnsyncedEdits('alice')).toBe(1);
    expect(await countUnsyncedEdits('bob')).toBe(0);
  });

  it('reports and removes responses of another account after a switch', async () => {
    await capture('alice');
    expect(await describeForeignOfflineData('bob')).toEqual({ records: 1, files: 0 });
    expect(await removeForeignOfflineData('bob')).toEqual({ records: 1, files: 0 });
    expect(await describeForeignOfflineData('bob')).toEqual({ records: 0, files: 0 });
  });
});
