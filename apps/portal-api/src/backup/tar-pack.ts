// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Streaming tar.gz writer for the backup path.
 *
 * WHY THIS EXISTS, and why it is not `createTarGz` from tar-cli.ts:
 *
 * The system-tar wrapper resolves member content by `open()`/`read()`
 * on the filesystem, so every byte it archives must already be a file.
 * That is what forced `runBackup` to mirror the whole MinIO bucket to
 * disk before sealing, and that intermediate copy is the reason a
 * backup needed roughly 2x (bucket + dump) free on the archive volume.
 * With a 32.67 GB bucket on a 98 GB volume the design had no operating
 * point even at retention zero: it was arithmetic, not bad luck.
 *
 * Object bodies arrive from S3 as `Readable` already. Packing in
 * process lets them go straight into the archive, so peak occupancy
 * drops to (dump + archive) and the bucket is never copied.
 *
 * WHY tar-stream RATHER THAN HAND-ROLLING USTAR: correctness here is
 * only discovered on the day someone restores. tar-stream is ~1k LOC
 * of pure stream transformation with no filesystem access, and we use
 * only its pack half. This is deliberately NOT a reversal of #47,
 * which removed the npm `tar` package: that dependency was ~110k LOC
 * whose advisories were overwhelmingly extraction path-traversal
 * bugs. Extraction still goes through the system binary
 * (tar-cli.extractTarGz); nothing here ever writes to the filesystem
 * except the single archive stream.
 *
 * FORMAT: byte-compatible with what `tar -czf` produced. Relative
 * member paths, gzip container, same `postgres/`, `minio/`,
 * `manifest.json` layout. Existing archives stay readable and
 * `backup-restore.service.ts` needs no change, which is the whole
 * point of packing rather than switching to a directory format.
 */

import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { pack as tarPack } from 'tar-stream';

/**
 * gzip level 1, not the default 6.
 *
 * `snapshot-golden.sh` measured this corpus directly: gzip buys
 * roughly nothing on a GIS bucket (COG, PMTiles, LAZ, JPEG and a
 * `pg_dump -Fc` that is already zlib-compressed) and costs ~40 minutes
 * of single-core CPU on ~30 GB. Level 1 keeps the output a valid gzip
 * stream that `tar -xzf` reads unchanged while spending a fraction of
 * the CPU. On incompressible payloads the size difference is in the
 * noise; on the compressible remainder it is small and worth trading.
 *
 * This matters beyond cost: the shipped schedule fires at 02:00 UTC
 * and the nightly reset stops portal-api at 04:00. A run that spends
 * 40 minutes in gzip is that much closer to being killed mid-write.
 */
const GZIP_LEVEL = 1;

/** A member whose bytes are already in memory (the manifest). */
export interface BufferEntry {
  kind: 'buffer';
  name: string;
  body: Buffer;
}

/** A member streamed from disk or from S3. */
export interface StreamEntry {
  kind: 'stream';
  name: string;
  /**
   * Exact byte length. A tar member header carries the size BEFORE
   * the content, so this is not a hint: see the contract note on
   * `writeTarGz` for what happens when it is wrong.
   */
  size: number;
  /** Opened lazily so we hold at most one body at a time. */
  open: () => Promise<Readable> | Readable;
}

export type TarEntry = BufferEntry | StreamEntry;

/**
 * Write `entries` to `file` as a gzipped tar, streaming each member.
 *
 * THE SIZE CONTRACT, which is the sharp edge of this whole approach:
 * tar writes a member's size in its header, ahead of the body. If a
 * body delivers a different number of bytes than `size` promised, the
 * archive is corrupt from that member onward and the damage is not
 * detectable until someone reads it back.
 *
 * That is a live risk here, not a theoretical one: the portal keeps
 * serving while a backup runs, so an object's length taken from a
 * `ListObjectsV2` page can be stale by the time its body is fetched.
 * Callers MUST take `size` from the GET response's ContentLength
 * rather than from the listing. This function enforces the contract
 * anyway by counting bytes and failing the whole archive on mismatch,
 * because a loud failure is worth far more than an archive that only
 * reveals itself as broken during a recovery.
 */
export async function writeTarGz(
  file: string,
  entries: AsyncIterable<TarEntry>,
): Promise<void> {
  const pack = tarPack();
  const gzip = createGzip({ level: GZIP_LEVEL });
  const out = createWriteStream(file);

  // Start the sink before feeding the pack: pipeline() attaches the
  // error handlers and backpressure that keep a 30 GB payload from
  // being buffered in memory. Kept as a promise so a producer error
  // below can destroy the chain and still be awaited.
  const sink = pipeline(pack, gzip, out);

  try {
    for await (const entry of entries) {
      if (entry.kind === 'buffer') {
        await new Promise<void>((resolve, reject) => {
          pack.entry({ name: entry.name, size: entry.body.length }, entry.body, (err) =>
            err ? reject(err) : resolve(),
          );
        });
        continue;
      }

      const body = await entry.open();
      const member = pack.entry({ name: entry.name, size: entry.size });
      let written = 0;
      // Count as we go so we can name the key and both byte counts.
      // tar-stream enforces the contract too, but it rejects with a
      // bare "Size mismatch" that says nothing about WHICH of tens of
      // thousands of objects changed, which is useless at 3am.
      body.on('data', (c: Buffer) => {
        written += c.length;
      });
      try {
        await pipeline(body, member);
      } catch (err) {
        throw new Error(
          `Archive member "${entry.name}" declared ${entry.size} bytes but ` +
            `delivered ${written}. The object changed underneath the backup ` +
            `(the portal keeps serving while a backup runs). Refusing to ` +
            `seal a corrupt archive. Underlying error: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Belt and braces: a body that ends exactly short without
      // erroring would otherwise pad silently.
      if (written !== entry.size) {
        throw new Error(
          `Archive member "${entry.name}" declared ${entry.size} bytes but ` +
            `delivered ${written}. Refusing to seal a corrupt archive.`,
        );
      }
    }
    pack.finalize();
  } catch (err) {
    // Tear the chain down so the sink promise settles instead of
    // hanging, then let the original error win.
    pack.destroy(err instanceof Error ? err : new Error(String(err)));
    await sink.catch(() => undefined);
    throw err;
  }

  await sink;
}
