// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool, type PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

import { type Observation } from '@gratis-gis/engine';

/**
 * COPY-based bulk writer for the observation table (#115 P3 + P9).
 *
 * Why this exists separately from EngineService.writeMany:
 *
 * The streaming-INSERT path through Prisma's $executeRawUnsafe goes
 * through the SQL parser, parameter binder, and protocol round-trip
 * for every batch. For an online write of one or two rows, that
 * overhead is a rounding error. For a million-row import, it's
 * minutes of wall clock spent in the pipe rather than the disk.
 *
 * `COPY ... FROM STDIN` is PostgreSQL's bulk-load wire protocol. We
 * stream rows as TEXT-format CSV-ish lines (tab separators, \\N for
 * null, geometry as EWKT so PostGIS parses on input) and the server
 * applies them with no per-row SQL parsing. Empirically 5-10x
 * faster than batched multi-row INSERTs for large imports.
 *
 * P9 worker-thread split: encoding observations to COPY lines
 * (per-coordinate EWKT, JSON.stringify on attrs, four regex passes
 * in escapeText) is CPU-bound. With everything on one thread the
 * GDAL feature pump and the COPY-stream writer were forced to wait
 * on the encoder. Moving the encoder to a worker_thread lets the
 * main thread keep pumping features and writing bytes while the
 * encoder works on the previous batch in parallel. On real-world
 * county-scale parcel imports (some polygons have 50000+ vertices)
 * this is roughly a 2x throughput win.
 *
 * Caveats:
 *   - We open a separate pg connection (pg-copy-streams needs the
 *     raw client; Prisma doesn't expose its underlying pool). The
 *     connection is short-lived: opened at the start of a job,
 *     closed at the end.
 *   - Geometry is encoded as EWKT (`SRID=4326;POINT (...)`),
 *     skipping ST_GeomFromGeoJSON entirely. PostGIS parses EWKT
 *     considerably faster than GeoJSON.
 *   - The `cell` h3 index is set null in the bulk path; #115 P4
 *     dropped the index that justified per-row computation.
 *   - This path bypasses derived-layer cache invalidation
 *     (notifySourceWrite). The worker fires a single bulk
 *     invalidation after the COPY completes -- cheaper than
 *     N per-row calls and good enough for the staleness window
 *     between import-finished and the next regular write.
 */
export class CopyWriter {
  private pool: Pool;
  private client: PoolClient | null = null;
  private stream: NodeJS.WritableStream | null = null;
  private rowCount = 0;
  private encoder: Worker | null = null;
  private nextRequestId = 0;
  private pending = new Map<
    number,
    { resolve: (lines: string) => void; reject: (err: Error) => void }
  >();

  constructor(databaseUrl: string) {
    // Single-use pool sized to one connection. The worker's
    // job-lifecycle owns this writer and we don't need
    // concurrency. min=0 so the connection closes cleanly when
    // the pool ends.
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      min: 0,
    });
  }

  /**
   * Convenience for callers that need no pre-COPY work inside the
   * transaction: open it and immediately enter COPY mode. Callers
   * that must run statements in the same transaction first (the
   * replace-mode scoped delete) call `begin()`, then their
   * statements, then `beginCopy()` themselves. Once the COPY
   * starts, the connection can execute nothing else until it ends.
   */
  async start(): Promise<void> {
    await this.begin();
    this.beginCopy();
  }

  /** Open the connection and the transaction WITHOUT starting the
   *  COPY stream yet, leaving room for statements that must share
   *  the transaction (see `deleteScope`). Pair with `beginCopy()`. */
  async begin(): Promise<void> {
    this.client = await this.pool.connect();
    // SET LOCAL synchronous_commit=off for this transaction.
    // Bulk imports are re-runnable; trading per-commit fsync
    // durability for ~20-30% throughput is the right call here.
    // The setting reverts at transaction end so other queries on
    // the same client (none in this design) get default behavior.
    await this.client.query('BEGIN');
    await this.client.query('SET LOCAL synchronous_commit = OFF');
  }

  /**
   * Delete every observation row in `scope` on this writer's own
   * connection, inside the transaction the subsequent COPY joins.
   * Replace-mode imports run their truncate through here so a
   * failed or cancelled import rolls the delete back together with
   * the partial COPY, restoring the exact pre-import state. A
   * truncate committed in a separate transaction (the old shape)
   * left the layer EMPTY on failure: old rows deleted, new rows
   * rolled back.
   *
   * Only valid between `begin()` and `beginCopy()`: once the COPY
   * statement is issued the connection is in copy-in mode and
   * rejects ordinary queries.
   */
  async deleteScope(scope: string): Promise<void> {
    if (!this.client) {
      throw new Error('CopyWriter.deleteScope called before begin().');
    }
    if (this.stream) {
      throw new Error(
        'CopyWriter.deleteScope called after beginCopy(); the COPY stream owns the connection now.',
      );
    }
    await this.client.query('DELETE FROM observation WHERE scope = $1', [
      scope,
    ]);
  }

  /** Issue the COPY statement and spawn the encoder worker. After
   *  this the connection is dedicated to the COPY until `end()` or
   *  `abort()`. */
  beginCopy(): void {
    if (!this.client) {
      throw new Error('CopyWriter.beginCopy called before begin().');
    }
    const sql =
      'COPY observation (' +
      [
        'id',
        'tx_time',
        'valid_from',
        'valid_to',
        'scope',
        'entity',
        'kind',
        'attrs',
        'geom',
        'cell',
        'author_sub',
        'source',
        'parents',
      ].join(', ') +
      ') FROM STDIN WITH (FORMAT text)';
    this.stream = this.client.query(copyFrom(sql)) as unknown as
      NodeJS.WritableStream;
    // Spawn the encoder worker_thread. The compiled JS sits at
    // dist/engine/copy-writer.js, with copy-encoder.worker.js next
    // to it. portal-api is built as CommonJS so we resolve via
    // __dirname rather than import.meta.url.
    this.encoder = new Worker(join(__dirname, 'copy-encoder.worker.js'));
    this.encoder.on('message', (msg: EncoderMessage) => {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.type === 'encoded') slot.resolve(msg.lines);
      else slot.reject(new Error(msg.message));
    });
    this.encoder.on('error', (err: unknown) => {
      // Fail every in-flight request; the worker is unrecoverable.
      // @types/node 25 tightened Worker.on('error') to typed-unknown;
      // wrap non-Error rejections so each slot resolves with the
      // shape its Promise consumers expect.
      const reason =
        err instanceof Error ? err : new Error(String(err));
      for (const [id, slot] of this.pending) {
        slot.reject(reason);
        this.pending.delete(id);
      }
    });
  }

  /**
   * Encode a batch of observations on the worker_thread and stream
   * the resulting COPY lines to the server. Backpressure-aware: if
   * the COPY stream's outgoing buffer is full we await the drain
   * event before resolving so the caller pauses GDAL until Postgres
   * has consumed enough bytes.
   *
   * Use this instead of calling write() per-row when you have a
   * batch in hand (every bulk import path does). One postMessage()
   * to encode 2000 rows beats 2000 round-trips.
   */
  async writeBatch(batch: Observation[]): Promise<void> {
    if (!this.stream || !this.encoder) {
      throw new Error('CopyWriter.writeBatch called before start().');
    }
    if (batch.length === 0) return;
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const lines = await new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // postMessage clones the batch. Date objects survive the
      // structured clone; nested attrs/source/geom are plain JSON
      // shapes. Send the batch in a single message so the worker
      // does only one parse/encode loop.
      this.encoder!.postMessage({
        type: 'encode',
        id,
        batch: batch.map((obs) => ({
          id: obs.id,
          txTime: obs.txTime,
          validFrom: obs.validFrom,
          validTo: obs.validTo,
          scope: obs.scope,
          entity: obs.entity,
          kind: obs.kind,
          attrs: obs.attrs,
          geom: obs.geom,
          cell: obs.cell ?? null,
          author: { sub: obs.author.sub, displayName: obs.author.displayName },
          source: obs.source,
          parents: obs.parents,
        })),
      });
    });
    this.rowCount += batch.length;
    const stream = this.stream;
    const ok = stream.write(lines);
    if (!ok) {
      // The COPY stream's buffer is full -- wait for the consumer
      // (the pg socket) to drain before we let the caller queue
      // more. Without this, large bursts grow the in-process
      // buffer unboundedly.
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          stream.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          stream.off('drain', onDrain);
          reject(err);
        };
        stream.once('drain', onDrain);
        stream.once('error', onError);
      });
    }
  }

  /**
   * Per-row write kept for compatibility with code paths that
   * stream observations one at a time (single-row online writes
   * never use this writer in practice, but the signature stays so
   * a future caller can add a row without batching). Internally
   * just a one-element batch.
   */
  async write(obs: Observation): Promise<void> {
    await this.writeBatch([obs]);
  }

  /**
   * Close the COPY stream and commit the transaction. Returns the
   * number of rows written. Errors during stream-end or commit
   * roll back the transaction, so a partially-streamed batch
   * never lands.
   */
  async end(): Promise<number> {
    if (!this.stream || !this.client) {
      throw new Error('CopyWriter.end called before start().');
    }
    const stream = this.stream;
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      stream.end();
    });
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    this.stream = null;
    if (this.encoder) {
      await this.encoder.terminate();
      this.encoder = null;
    }
    return this.rowCount;
  }

  /** Abort the in-flight COPY and roll back. Call from a finally
   *  branch when the caller throws mid-write so the connection
   *  isn't leaked back to the pool with an open transaction. */
  async abort(): Promise<void> {
    try {
      if (this.client) {
        await this.client.query('ROLLBACK');
      }
    } catch {
      // Best-effort; nothing to do if the transaction is already
      // dead.
    } finally {
      this.client?.release();
      this.client = null;
      this.stream = null;
      if (this.encoder) {
        try {
          await this.encoder.terminate();
        } catch {
          /* best effort */
        }
        this.encoder = null;
      }
    }
  }

  /** Tear down the pool when the worker is done with this writer.
   *  Important so process shutdown doesn't hang on an open pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

type EncoderMessage =
  | { type: 'encoded'; id: number; lines: string }
  | { type: 'error'; id: number; message: string };
