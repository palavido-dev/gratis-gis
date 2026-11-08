// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

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
  private stream: Writable | null = null;
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
    // synchronous_commit stays ON. Turning it off let COMMIT return
    // before the WAL flush, so a power loss could drop a load the
    // job row later called succeeded, or leave rows behind a job
    // the reaper marked failed. County imports pay the fsync.
    await this.client.query('BEGIN');
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

  /** Latest live entity ids in `scope`. Call before `deleteScope` on
   *  a replace so the commit can write tombstones for entities the
   *  new file does not contain. Invalid once COPY has started. */
  async liveEntityIds(scope: string): Promise<string[]> {
    const result = await this.query<{ entity: string }>(
      `SELECT entity::text AS entity
       FROM (
         SELECT DISTINCT ON (entity) entity, kind
         FROM observation
         WHERE scope = $1
         ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
       ) latest
       WHERE kind <> 'delete'`,
      [scope],
    );
    return result.rows.map((row) => row.entity);
  }

  /** Ordinary SQL on this writer's connection. Only between `begin`
   *  and `beginCopy`, and again after `sealCopy` until `commit`.
   *  The COPY stream owns the connection in between. */
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('CopyWriter.query called without a connection.');
    }
    if (this.stream) {
      throw new Error('CopyWriter.query called while COPY is open.');
    }
    return this.client.query<T>(sql, params);
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
    this.stream = this.client.query(copyFrom(sql)) as unknown as Writable;
    // The compiled image has copy-encoder.worker.js beside this file.
    // A test run from the TypeScript source does not, so it loads the
    // .ts file with the type stripper. The worker has no other imports.
    const compiled = join(__dirname, 'copy-encoder.worker.js');
    const script = existsSync(compiled)
      ? compiled
      : join(__dirname, 'copy-encoder.worker.ts');
    this.encoder = new Worker(script, {
      execArgv: script.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    });
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
   * Finish the COPY stream and leave the transaction open. An append
   * drops duplicate creates next, then the caller stamps syncVersion,
   * then `commit`. A partial stream that throws never reaches here;
   * `abort` destroys the connection and Postgres rolls the transaction
   * back.
   */
  async sealCopy(): Promise<void> {
    if (!this.stream || !this.client) {
      throw new Error('CopyWriter.sealCopy called before start().');
    }
    const stream = this.stream;
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      stream.end();
    });
    this.stream = null;
    if (this.encoder) {
      await this.encoder.terminate();
      this.encoder = null;
    }
  }

  /**
   * Remove create rows this transaction just inserted when they are
   * not the first live observation for that entity.
   *
   * Only rows whose xmin is this transaction's xid are eligible.
   * `pg_current_xact_id()::xid` stays equal to xmin after the
   * 32-bit xid counter wraps. `xmin::text::bigint = txid_current()`
   * does not: txid_current() keeps the epoch. Committed
   * history, updates, deletes, other scopes, and duplicates that
   * were already stored are left alone. A create after a committed
   * delete is kept. Two creates for a new entity in this load keep
   * the earliest. Advisory locks on the entities we just wrote make
   * a concurrent append wait, then see the winner's commit.
   */
  async dropDuplicateAppendCreates(scope: string): Promise<number> {
    if (!this.client) {
      throw new Error(
        'CopyWriter.dropDuplicateAppendCreates called without a connection.',
      );
    }
    if (this.stream) {
      throw new Error(
        'CopyWriter.dropDuplicateAppendCreates called while COPY is open.',
      );
    }
    await this.client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(k, 0))
       FROM (
         SELECT DISTINCT scope || '|' || entity::text AS k
         FROM observation
         WHERE scope = $1
           AND kind = 'create'
           AND xmin = pg_current_xact_id()::xid
         ORDER BY 1
       ) locks`,
      [scope],
    );
    const result = await this.client.query(
      `DELETE FROM observation AS fresh
       WHERE fresh.scope = $1
         AND fresh.kind = 'create'
         AND fresh.xmin = pg_current_xact_id()::xid
         AND (
           EXISTS (
             SELECT 1
             FROM (
               SELECT prev.kind
               FROM observation AS prev
               WHERE prev.scope = fresh.scope
                 AND prev.entity = fresh.entity
                 AND prev.xmin IS DISTINCT FROM pg_current_xact_id()::xid
               ORDER BY prev.valid_from DESC, prev.tx_time DESC, prev.id DESC
               LIMIT 1
             ) prior
             WHERE prior.kind <> 'delete'
           )
           OR EXISTS (
             SELECT 1
             FROM observation AS sibling
             WHERE sibling.scope = fresh.scope
               AND sibling.entity = fresh.entity
               AND sibling.kind = 'create'
               AND sibling.xmin = pg_current_xact_id()::xid
               AND sibling.id <> fresh.id
               AND (sibling.tx_time, sibling.id) < (fresh.tx_time, fresh.id)
           )
         )`,
      [scope],
    );
    return result.rowCount ?? 0;
  }

  async commit(): Promise<number> {
    if (!this.client) {
      throw new Error('CopyWriter.commit called without a connection.');
    }
    if (this.stream) {
      throw new Error('CopyWriter.commit called while COPY is open.');
    }
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    return this.rowCount;
  }

  /** Seal the stream and commit. Callers that must run SQL after
   *  the stream use `sealCopy` and `commit` themselves. */
  async end(): Promise<number> {
    await this.sealCopy();
    return this.commit();
  }

  /** Abort the in-flight COPY and roll back. Call from a finally
   *  branch when the caller throws mid-write so the connection
   *  isn't leaked back to the pool with an open transaction.
   *
   *  Does NOT issue a ROLLBACK on this connection. Once `beginCopy`
   *  has run the connection is in copy-in mode, and a plain query
   *  (ROLLBACK) hangs forever: the server is waiting for COPY data or
   *  a copy-end, not SQL. A bad-file replace import (streamLayerFromPath
   *  throws immediately after beginCopy, with zero rows written) hit
   *  exactly this and left an uncommitted scope-delete transaction
   *  open on the server. Instead we destroy the connection; Postgres
   *  rolls the open transaction back on the disconnect, which can
   *  never hang. Connection reuse does not matter on an abort. */
  async abort(): Promise<void> {
    // Tear the COPY stream down first (best-effort) so nothing keeps
    // writing into a socket we are about to drop.
    if (this.stream) {
      // Destroying the socket emits 'error' on the next tick. Without
      // a listener that becomes an unhandled error and can take the
      // worker down after a cancel that already rolled back.
      this.stream.on('error', () => {});
      try {
        this.stream.destroy();
      } catch {
        /* already torn down */
      }
      this.stream = null;
    }
    if (this.client) {
      this.client.on('error', () => {});
      try {
        // Passing a truthy value destroys the client instead of
        // returning it to the pool; the disconnect rolls back the
        // transaction server-side.
        this.client.release(true);
      } catch {
        /* best effort */
      }
      this.client = null;
    }
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

  /** Tear down the pool when the worker is done with this writer.
   *  Important so process shutdown doesn't hang on an open pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

type EncoderMessage =
  | { type: 'encoded'; id: number; lines: string }
  | { type: 'error'; id: number; message: string };
