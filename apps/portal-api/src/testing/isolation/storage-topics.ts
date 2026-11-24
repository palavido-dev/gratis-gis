// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Isolation cases for object storage: org B must not read, overwrite,
// delete, copy or get a signed URL for an object of org A by sending
// its key, its id or a crafted path, while org A keeps full use of it.
// Objects are made through the real upload flow (presign, then the
// bytes written where the browser's PUT would put them).

import type { TenancyMode } from '../../common/tenancy.js';
import { ObjectKeyRefusedError, parseObjectKey } from '../../storage/object-keys.js';
import { StorageService } from '../../storage/storage.service.js';
import { memoryS3Of } from '../memory-s3.js';
import { LAYER_ID, api, type ApiResult, type FixtureUser } from './seed.js';
import type { SuiteState, Verdict } from './suite.js';

type Topic = {
  name: string;
  modes: TenancyMode[];
  run(state: SuiteState): Promise<Verdict>;
};

const BOTH: TenancyMode[] = ['single', 'multi'];

const short = (r: ApiResult): string => `${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`;

function storageOf(state: SuiteState): StorageService {
  return state.app.app.get(StorageService);
}

/** Upload a private file item as `who` and return its key and id. */
async function uploadFile(
  state: SuiteState,
  who: FixtureUser,
  body: string,
): Promise<{ key: string; itemId: string; url: string }> {
  const presign = await api(state.app.baseUrl, who, 'POST', '/api/storage/presign-upload', {
    kind: 'item-file',
    contentType: 'text/plain',
    sizeBytes: Buffer.byteLength(body),
  });
  if (presign.status >= 300) throw new Error(`presign failed: ${short(presign)}`);
  const { key, publicUrl } = presign.body as { key: string; publicUrl: string };
  memoryS3Of(storageOf(state)).put(key, body, 'text/plain');
  const created = await api(state.app.baseUrl, who, 'POST', '/api/items', {
    type: 'file',
    title: 'Storage probe',
    access: 'private',
    data: {
      storageKey: key,
      storageUrl: publicUrl,
      fileName: 'probe.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(body),
    },
  });
  if (created.status >= 300) throw new Error(`file item create failed: ${short(created)}`);
  return { key, itemId: (created.body as { id: string }).id, url: publicUrl };
}

/** `/api/portal/storage/...` (what the browser holds) to the API path. */
function apiPath(publicUrl: string): string {
  return publicUrl.replace(/^\/api\/portal\//, '/api/');
}

export const STORAGE_TOPICS: Topic[] = [
  {
    name: 'storage: new objects are stored under the uploading org',
    modes: BOTH,
    async run(state) {
      const problems: string[] = [];
      for (const org of [state.fx.A, state.fx.B]) {
        const r = await api(
          state.app.baseUrl,
          org.users.contributor,
          'POST',
          '/api/storage/presign-upload',
          {
            kind: 'item-file',
            contentType: 'text/plain',
            sizeBytes: 3,
          },
        );
        const key = (r.body as { key?: string } | undefined)?.key;
        if (parseObjectKey(key)?.orgId !== org.orgId) {
          problems.push(`org ${org.key} got key ${String(key)} (${r.status})`);
        }
      }
      // The client cannot name the key it uploads to.
      const own = await uploadFile(state, state.fx.A.users.contributor, 'a-bytes');
      const forced = await api(
        state.app.baseUrl,
        state.fx.B.users.contributor,
        'POST',
        '/api/storage/presign-upload',
        {
          kind: 'item-file',
          contentType: 'text/plain',
          sizeBytes: 3,
          key: own.key,
        },
      );
      const got = (forced.body as { key?: string } | undefined)?.key;
      if (
        forced.status < 300 &&
        (got === own.key || parseObjectKey(got)?.orgId !== state.fx.B.orgId)
      ) {
        problems.push(`presign let org B choose the key: ${short(forced)}`);
      }
      return { ok: problems.length === 0, problems };
    },
  },
  {
    name: 'storage: org B cannot read, copy or attach org A objects by key, id or crafted path',
    modes: BOTH,
    async run(state) {
      const { A, B } = state.fx;
      const secret = `secret-of-A-${Date.now()}`;
      const a = await uploadFile(state, A.users.contributor, secret);
      const parsed = parseObjectKey(a.key)!;
      const uuid = parsed.rest;
      const base = state.app.baseUrl;
      const problems: string[] = [];

      // Control: org A reads its own file through the private route.
      const ownRead = await api(base, A.users.contributor, 'GET', apiPath(a.url));
      if (ownRead.status !== 200 || !ownRead.text.includes(secret)) {
        problems.push(`org A could not read its own file: ${short(ownRead)}`);
      }

      const leaks = (r: ApiResult): boolean =>
        (r.status >= 200 && r.status < 300) || r.text.includes(secret);
      const paths = [
        apiPath(a.url),
        // Another org's segment, the older layout, another kind.
        `/api/storage/private/item-file/o/${B.orgId}/${uuid}`,
        `/api/storage/private/item-file/${uuid}`,
        `/api/storage/private/feature-attachment/o/${A.orgId}/${uuid}`,
        `/api/storage/private/item-tile-layer/o/${A.orgId}/${uuid}`,
        // Case and look-alikes.
        `/api/storage/private/item-file/o/${A.orgId.toUpperCase()}/${uuid}`,
        `/api/storage/private/item-file/O/${A.orgId}/${uuid}`,
        `/api/storage/private/item-fil%D0%B5/o/${A.orgId}/${uuid}`,
        // Encoded separators and traversal.
        `/api/storage/private/item-file/o%2F${A.orgId}%2F${uuid}`,
        `/api/storage/private/item-file/${encodeURIComponent(`o/${A.orgId}/${uuid}`)}`,
        `/api/storage/private/item-file/o/${B.orgId}/..%2F..%2Fo%2F${A.orgId}%2F${uuid}`,
        `/api/storage/private/item-file/o/${A.orgId}/${uuid}%00`,
      ];
      for (const path of paths) {
        for (const who of [B.users.admin, null]) {
          const r = await api(base, who, 'GET', path);
          if (leaks(r)) problems.push(`${who ? 'org B' : 'anonymous'} GET ${path}: ${short(r)}`);
        }
      }
      // By id: the item itself and its download routes.
      const byId = await api(base, B.users.admin, 'GET', `/api/items/${a.itemId}`);
      if (leaks(byId)) problems.push(`org B read the item by id: ${short(byId)}`);

      // Copy: point an item or an attachment of org B at the key.
      const copy = await api(base, B.users.contributor, 'POST', '/api/items', {
        type: 'file',
        title: 'copy',
        access: 'private',
        data: { storageKey: a.key, fileName: 'x.txt', mimeType: 'text/plain', sizeBytes: 1 },
      });
      if (copy.status < 300) problems.push(`org B created an item on org A's key: ${short(copy)}`);
      const bLayer = B.items['data_layer:private'];
      const bFeature = B.featureIds[0];
      if (bLayer && bFeature) {
        const attach = await api(
          base,
          B.users.admin,
          'POST',
          `/api/items/${bLayer}/layers/${LAYER_ID}/features/${bFeature}/attachments`,
          {
            fileName: 'x.txt',
            mime: 'text/plain',
            sizeBytes: 1,
            storageKey: `feature-attachment/o/${A.orgId}/${uuid}`,
            storageUrl: '/x',
          },
        );
        if (attach.status < 300) problems.push(`org B attached an org A key: ${short(attach)}`);
      }
      const bTile = B.items['tile_layer:private'];
      if (bTile) {
        const fin = await api(
          base,
          B.users.admin,
          'POST',
          `/api/items/${bTile}/tile-layer/finalize`,
          {
            storageKey: `item-tile-layer/o/${A.orgId}/${uuid}`,
            storageUrl: 'x',
            fileName: 'x.pmtiles',
            sizeBytes: 1,
          },
        );
        if (fin.status < 300)
          problems.push(`org B finalized a tile layer on an org A key: ${short(fin)}`);
      }

      // Nothing of org A's changed, and A still reads it.
      if (!memoryS3Of(storageOf(state)).objects.has(a.key))
        problems.push('org A object was removed');
      const after = await api(base, A.users.contributor, 'GET', apiPath(a.url));
      if (after.status !== 200) problems.push(`org A lost its file: ${short(after)}`);
      return { ok: problems.length === 0, problems };
    },
  },
  {
    name: 'storage: every storage call refuses another org, and malformed keys for any org',
    modes: BOTH,
    async run(state) {
      const { A, B } = state.fx;
      const storage = storageOf(state);
      const s3 = memoryS3Of(storage);
      const a = await uploadFile(state, A.users.contributor, 'direct-bytes');
      const asA = { orgId: A.orgId };
      const asB = { orgId: B.orgId };
      const problems: string[] = [];

      const refused = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
          problems.push(`${label}: went through`);
        } catch (err) {
          if (!(err instanceof ObjectKeyRefusedError) && !/not allowed/.test(String(err))) {
            problems.push(`${label}: failed another way: ${String(err)}`);
          }
        }
      };
      const passes = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          problems.push(`${label}: refused for the owner: ${String(err)}`);
        }
      };

      // Org B, by verb.
      await refused('read', () => storage.streamObject(a.key, asB));
      await refused('ranged read', () => storage.streamObject(a.key, asB, 'bytes=0-3'));
      await refused('read to disk', () => storage.streamObjectToDisk(a.key, asB, '/dev/null'));
      await refused('head', () => storage.headObjectSize(a.key, asB));
      await refused('exists', () => storage.objectExists(a.key, asB));
      await refused('raster path', () => storage.vsis3Path(a.key, asB));
      await refused('delete', () => storage.deleteObject(a.key, asB));
      await refused('overwrite (multipart)', () => storage.createMultipartUpload(a.key, asB));
      await refused('sign a part URL', () => storage.presignUploadPart(a.key, asB, 'u', 1, 1, 60));
      await refused('list parts', () => storage.listUploadedParts(a.key, asB, 'u'));
      await refused('complete', () => storage.completeMultipartUpload(a.key, asB, 'u', []));
      await refused('abort', () => storage.abortMultipartUpload(a.key, asB, 'u'));
      await refused('record usage', () => storage.recordUploaded(a.key, asB));
      await refused('list under org A', () =>
        storage.listObjectsUnder(`item-file/o/${A.orgId}/`, asB),
      );
      await refused('list all', () => storage.listObjectsUnder('item-file/', asB));
      await refused('list open uploads', () =>
        storage.listMultipartUploadsUnder('ingest-upload/', asB),
      );
      if (!s3.objects.has(a.key)) problems.push('the object was deleted by org B');

      // Crafted keys, refused even for org A.
      const uuid = parseObjectKey(a.key)!.rest;
      for (const key of [
        `item-file/o/${A.orgId}/../${uuid}`,
        `item-file/o/${A.orgId}/./${uuid}`,
        `item-file/o/${A.orgId}//${uuid}`,
        `item-file/o/${A.orgId}%2F${uuid}`,
        `item-file\\o\\${A.orgId}\\${uuid}`,
        `item-file/o/${A.orgId.toUpperCase()}/${uuid}`,
        `ITEM-FILE/o/${A.orgId}/${uuid}`,
        `item-filе/o/${A.orgId}/${uuid}`,
        `item-file／o／${A.orgId}／${uuid}`,
        `/item-file/o/${A.orgId}/${uuid}`,
        `backups/o/${A.orgId}/${uuid}`,
      ]) {
        await refused(`crafted ${JSON.stringify(key)}`, () => storage.streamObject(key, asA));
      }

      // Controls: the owner gets every read and its listing.
      await passes('owner read', () =>
        storage.streamObject(a.key, asA).then((o) => o.body.destroy()),
      );
      await passes('owner head', () => storage.headObjectSize(a.key, asA));
      await passes('owner raster path', () => storage.vsis3Path(a.key, asA));
      await passes('owner list', () => storage.listObjectsUnder(`item-file/o/${A.orgId}/`, asA));
      return { ok: problems.length === 0, problems };
    },
  },
  {
    name: 'storage usage: each org counts its own uploads; trash keeps them, purge removes them',
    modes: BOTH,
    async run(state) {
      const { A, B } = state.fx;
      const base = state.app.baseUrl;
      const problems: string[] = [];
      const usage = async (who: FixtureUser): Promise<{ objectBytes: number; text: string }> => {
        const r = await api(base, who, 'GET', '/api/admin/storage-usage');
        if (r.status !== 200) problems.push(`usage read failed for ${who.orgKey}: ${short(r)}`);
        return {
          objectBytes: (r.body as { objectBytes?: number } | undefined)?.objectBytes ?? -1,
          text: r.text,
        };
      };
      const a0 = await usage(A.users.admin);
      const b0 = await usage(B.users.admin);
      const body = 'x'.repeat(1234);
      const file = await uploadFile(state, A.users.admin, body);
      const a1 = await usage(A.users.admin);
      const b1 = await usage(B.users.admin);
      if (a1.objectBytes !== a0.objectBytes + 1234) {
        problems.push(`org A usage moved by ${a1.objectBytes - a0.objectBytes}, expected 1234`);
      }
      if (b1.objectBytes !== b0.objectBytes) problems.push('org B usage moved on an org A upload');
      if (b1.text.includes(A.orgId)) problems.push("org B's usage names org A");

      // Org B cannot purge it; nothing moves.
      const bPurge = await api(base, B.users.admin, 'DELETE', `/api/items/${file.itemId}/purge`);
      if (bPurge.status < 300) problems.push(`org B purged org A's item: ${short(bPurge)}`);
      // Trash and restore keep the bytes counted.
      await api(base, A.users.admin, 'DELETE', `/api/items/${file.itemId}`);
      if ((await usage(A.users.admin)).objectBytes !== a1.objectBytes)
        problems.push('trash changed usage');
      await api(base, A.users.admin, 'POST', `/api/items/${file.itemId}/restore`);
      if ((await usage(A.users.admin)).objectBytes !== a1.objectBytes)
        problems.push('restore changed usage');
      // Purge deletes the object and takes it off.
      await api(base, A.users.admin, 'DELETE', `/api/items/${file.itemId}`);
      const purge = await api(base, A.users.admin, 'DELETE', `/api/items/${file.itemId}/purge`);
      if (purge.status >= 300) problems.push(`org A purge failed: ${short(purge)}`);
      const a2 = await usage(A.users.admin);
      if (a2.objectBytes !== a0.objectBytes)
        problems.push(`purge left usage at ${a2.objectBytes}, expected ${a0.objectBytes}`);
      if (memoryS3Of(storageOf(state)).objects.has(file.key))
        problems.push('purge left the object in the store');
      return { ok: problems.length === 0, problems };
    },
  },
  {
    name: 'storage: an object under an older key still reads for its org only',
    modes: BOTH,
    async run(state) {
      const { A, B } = state.fx;
      const problems: string[] = [];
      const layer = A.items['data_layer:private'];
      const feature = A.featureIds[0];
      if (!layer || !feature || !A.attachmentId) return { ok: true, problems: [] };
      // The seeded attachment has a key in the older layout.
      memoryS3Of(storageOf(state)).put(
        `feature-attachment/${A.attachmentKey}`,
        'old-bytes',
        'text/plain',
      );
      const path = `/api/items/${layer}/layers/${LAYER_ID}/features/${feature}/attachments/${A.attachmentId}/download`;
      const own = await api(state.app.baseUrl, A.users.admin, 'GET', path);
      if (own.status !== 200 || !own.text.includes('old-bytes')) {
        problems.push(`org A could not read its older attachment: ${short(own)}`);
      }
      const other = await api(state.app.baseUrl, B.users.admin, 'GET', path);
      if (other.status < 300 || other.text.includes('old-bytes')) {
        problems.push(`org B read org A's older attachment: ${short(other)}`);
      }
      const direct = await api(
        state.app.baseUrl,
        B.users.admin,
        'GET',
        `/api/storage/private/feature-attachment/${A.attachmentKey}`,
      );
      if (direct.status < 300 || direct.text.includes('old-bytes')) {
        problems.push(`org B read it by key: ${short(direct)}`);
      }
      if (state.mode === 'multi') {
        // With many organizations the ledger decides, at the storage layer too.
        try {
          await storageOf(state).streamObject(`feature-attachment/${A.attachmentKey}`, {
            orgId: B.orgId,
          });
          problems.push('the storage layer let org B read an older key of org A');
        } catch (err) {
          if (!(err instanceof ObjectKeyRefusedError)) problems.push(`unexpected: ${String(err)}`);
        }
      }
      return { ok: problems.length === 0, problems };
    },
  },
];
