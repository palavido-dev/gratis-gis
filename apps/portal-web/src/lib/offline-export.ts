// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PendingBlob, QueueRecord } from './offline-store';
import { zipStore, type ZipEntry } from './zip-store';

export interface OfflineRecoveryInput {
  dataCollectionId: string;
  deploymentTitle: string;
  username: string;
  /** When the file was built, ISO-8601. The caller passes it so tests are stable. */
  exportedAt: string;
  records: QueueRecord[];
  blobs: PendingBlob[];
}

/**
 * A zip a collector can hand to someone else when sync cannot run.
 * The JSON lists every unsynced edit. Each photo or file is a real
 * file in `files/`, not a name and not a base64 string.
 */
export async function buildOfflineRecoveryZip(
  input: OfflineRecoveryInput,
): Promise<{ filename: string; bytes: Uint8Array }> {
  const files: Array<{
    blobId: string;
    globalId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    path: string;
  }> = [];
  const entries: ZipEntry[] = [];
  for (const blob of input.blobs) {
    const safeName = blob.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    const path = `files/${blob.blobId}/${safeName}`;
    const bytes = new Uint8Array(await blob.blob.arrayBuffer());
    files.push({
      blobId: blob.blobId,
      globalId: blob.globalId,
      fileName: blob.fileName,
      mimeType: blob.mimeType,
      sizeBytes: bytes.byteLength,
      path,
    });
    entries.push({ name: path, data: bytes });
  }
  const manifest = {
    kind: 'gratisgis-offline-recovery',
    version: 1,
    dataCollectionId: input.dataCollectionId,
    deploymentTitle: input.deploymentTitle,
    username: input.username,
    exportedAt: input.exportedAt,
    note:
      'These edits and files had not synced when this copy was saved. They are not a portal backup.',
    records: input.records.map((record) => ({
      id: record.id,
      op: record.op,
      dataLayerId: record.dataLayerId,
      layerKey: record.layerKey,
      globalId: record.globalId,
      geometry: record.geometry,
      properties: record.properties,
      queuedAt: record.queuedAt,
      schemaHash: record.schemaHash,
      syncStatus: record.syncStatus,
      failure: record.failure ?? null,
      ownerUserId: record.ownerUserId ?? null,
    })),
    files,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  entries.unshift({ name: 'pending-edits.json', data: json });
  const day = input.exportedAt.slice(0, 10);
  const slug = input.deploymentTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'deployment';
  const who = input.username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'user';
  return {
    filename: `pending-${slug}-${who}-${day}.zip`,
    bytes: zipStore(entries),
  };
}
