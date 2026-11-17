// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read a device offline-recovery zip back into records and file bytes.
 * This is the copy the phone exported. It is not a promise that a phone
 * which never saved or uploaded those edits can be restored.
 */
import { inflateRawSync } from 'node:zlib';

function findEocd(buf) {
  const sig = 0x06054b50;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  throw new Error('Not a zip file.');
}

export function readZip(bytes) {
  const buf = Buffer.from(bytes);
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let central = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(central) !== 0x02014b50) {
      throw new Error('Bad zip directory.');
    }
    const method = buf.readUInt16LE(central + 10);
    const compSize = buf.readUInt32LE(central + 20);
    const nameLen = buf.readUInt16LE(central + 28);
    const extraLen = buf.readUInt16LE(central + 30);
    const commentLen = buf.readUInt16LE(central + 32);
    const local = buf.readUInt32LE(central + 42);
    const name = buf.subarray(central + 46, central + 46 + nameLen).toString('utf8');
    const nameLenLocal = buf.readUInt16LE(local + 26);
    const extraLenLocal = buf.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLenLocal + extraLenLocal;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed);
    files.set(name, data);
    central += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function readOfflineRecovery(bytes) {
  const files = readZip(bytes);
  const manifestBytes = files.get('pending-edits.json');
  if (!manifestBytes) throw new Error('The bundle has no pending-edits.json.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.kind !== 'gratisgis-offline-recovery' || manifest.version !== 1) {
    throw new Error('This is not a GratisGIS offline recovery bundle.');
  }
  const records = Array.isArray(manifest.records) ? manifest.records : [];
  const restored = [];
  for (const file of manifest.files ?? []) {
    const data = files.get(file.path);
    if (!data) throw new Error('A listed file is missing from the bundle.');
    restored.push({ ...file, bytes: data });
  }
  return {
    dataCollectionId: manifest.dataCollectionId,
    records,
    files: restored,
    note: 'Only edits that were in this file are restored. A phone that never saved this bundle still has nothing to recover.',
  };
}
