// SPDX-License-Identifier: AGPL-3.0-or-later
import { HttpException, HttpStatus } from '@nestjs/common';
import { statfs } from 'node:fs/promises';

/**
 * How many ingest parses may run at once, per process. These slots
 * bound parsing, not receiving: uploads still arriving are admitted
 * (and counted against free disk) in disk-upload.ts. One per user
 * stops a single account from taking both slots.
 */
const MAX_GLOBAL = 2;
const MAX_PER_USER = 1;

/** Spare bytes required beyond the upload itself. */
export const INGEST_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

let globalInFlight = 0;
const perUser = new Map<string, number>();

export class IngestBusyException extends HttpException {
  constructor() {
    super(
      'Too many imports are already running. Wait for one to finish and try again.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class IngestDiskException extends HttpException {
  constructor() {
    super(
      'Not enough free disk to accept this file. Free some space and try again.',
      HttpStatus.INSUFFICIENT_STORAGE,
    );
  }
}

/**
 * Reserve a slot. Call the returned function exactly once when the
 * request is finished, including on failure. The check and the
 * increment are synchronous so two requests cannot both pass.
 */
export function acquireIngestSlot(userId: string): () => void {
  const mine = perUser.get(userId) ?? 0;
  if (mine >= MAX_PER_USER || globalInFlight >= MAX_GLOBAL) {
    throw new IngestBusyException();
  }
  perUser.set(userId, mine + 1);
  globalInFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalInFlight -= 1;
    const next = (perUser.get(userId) ?? 1) - 1;
    if (next <= 0) perUser.delete(userId);
    else perUser.set(userId, next);
  };
}

/** Test hook. Production code does not reset a live process this way. */
export function resetIngestSlotsForTests(): void {
  globalInFlight = 0;
  perUser.clear();
}

export function assertIngestDiskRoom(
  fileBytes: number,
  availableBytes: number,
): void {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new IngestDiskException();
  }
  if (availableBytes < fileBytes + INGEST_DISK_HEADROOM_BYTES) {
    throw new IngestDiskException();
  }
}

/**
 * Refuse the upload when the filesystem holding `dir` cannot fit the
 * file plus headroom. A statfs failure is treated as "no room": an
 * ingest we cannot measure is not allowed to fill the disk.
 */
export async function assertIngestDiskRoomAt(
  dir: string,
  fileBytes: number,
): Promise<void> {
  let available: number;
  try {
    const stats = await statfs(dir);
    available = stats.bavail * stats.bsize;
  } catch {
    throw new IngestDiskException();
  }
  assertIngestDiskRoom(fileBytes, available);
}
