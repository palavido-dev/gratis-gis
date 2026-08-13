// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Client as PgClient } from 'pg';

/**
 * Process-wide leader election via PostgreSQL session-level
 * advisory locks (#115 #2 horizontal-scale).
 *
 * Why we need it: with N>1 portal-api replicas behind a load
 * balancer, every @Cron handler in the codebase fires on every
 * replica. Most of them aren't idempotent at N-fan-out:
 *   - BackupCronService would write N concurrent pg_dumps
 *     against the same archive directory and step on each
 *     other.
 *   - HousekeepingCronService would email the same admin N
 *     times every interval.
 *   - notifications.worker would drain the queue N times,
 *     racing the same submitted-rows window.
 *   - ingest-staging cleanup would race-delete each other's
 *     in-flight tmp files.
 *
 * The cheap, no-extra-infra answer is a Postgres advisory lock.
 * We open a dedicated long-lived pg connection and try
 * pg_try_advisory_lock(). The first replica to acquire wins;
 * others noop on cron handlers (`shouldRun()` returns false).
 * The lock is tied to the connection's lifetime.
 *
 * Boot-time election alone was NOT enough (the original v1
 * assumption). A session advisory lock is released the instant its
 * connection drops, so a mid-life Postgres restart or a dropped
 * connection frees the lock while the ex-leader still believes it
 * leads: its crons keep firing (double-fire once a follower also
 * acquires) or, if it demoted, nobody runs them. So this service
 * now actively maintains leadership:
 *   - the dedicated client has `error` / `end` handlers that demote
 *     immediately and drop the client (without them a stray idle
 *     error would surface as an unhandledException);
 *   - a poll timer reconnects when the client is gone, tries to
 *     acquire when we are a follower with a live connection, and
 *     verifies the connection is still alive when we lead (a dead
 *     connection means the lock is gone, so we demote and let the
 *     next tick reacquire).
 *
 * The lock key is a pair of int4 values; we picked a
 * GratisGIS-specific magic number for the namespace (the int4
 * representation of the ascii bytes "GGIS" interpreted as a
 * little-endian uint32) and 1 for the cron-leader scope.
 */
const LEADER_NAMESPACE = 0x47474953; // 'GGIS'
const LEADER_SCOPE_CRONS = 1;

/**
 * How often to reconcile leadership: reconnect if the client died,
 * try to acquire if we are a live follower, verify liveness if we
 * lead. 15s bounds how long a dead leader's crons pause before a
 * follower picks them up, without hammering Postgres.
 */
const POLL_MS = 15_000;

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeaderElectionService.name);
  private client: PgClient | null = null;
  private isLeader = false;
  private connecting = false;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;

  async onModuleInit(): Promise<void> {
    // Some non-prod / test boots set ENABLE_CRONS=false explicitly
    // because they don't want cron side-effects regardless of
    // leadership. Honor that without ever attempting the lock so
    // a missing DATABASE_URL doesn't crash boot in those cases.
    if (process.env.ENABLE_CRONS === 'false') {
      this.log.log(
        'ENABLE_CRONS=false — skipping leader election; this replica will never run crons.',
      );
      return;
    }

    if (!process.env.DATABASE_URL) {
      this.log.warn(
        'DATABASE_URL not set; cannot acquire leader lock. Crons will run on every replica until this is fixed.',
      );
      this.isLeader = true;
      return;
    }

    await this.connectAndAcquire();

    // Reconcile on a timer. unref so the interval never keeps the
    // process (or a Jest worker) alive on its own.
    this.pollTimer = setInterval(() => {
      void this.reconcile();
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.teardownClient(true);
    this.isLeader = false;
  }

  /**
   * Returns true if this process currently holds the cron-leader
   * lock. Cron handlers (and any other "exactly-once-across-replicas"
   * recurring work) should early-return when this is false:
   *
   *   @Cron('0 2 * * *')
   *   async dailyBackup() {
   *     if (!this.leader.shouldRun()) return;
   *     // ...
   *   }
   */
  shouldRun(): boolean {
    return this.isLeader;
  }

  /**
   * Open the dedicated connection and attempt to acquire the lock.
   * Safe to call repeatedly: it no-ops while a connect is already in
   * flight and while a client already exists.
   */
  private async connectAndAcquire(): Promise<void> {
    if (this.stopped || this.connecting || this.client) return;
    this.connecting = true;
    const client = new PgClient({
      connectionString: process.env.DATABASE_URL,
    });
    // Attach the drop handlers BEFORE connect so a failure during or
    // right after connect demotes us instead of throwing into the
    // process-level uncaughtException handler.
    client.on('error', (err) => {
      this.log.warn(
        `Leader lock connection error: ${
          err instanceof Error ? err.message : err
        }. Demoting; will reacquire on the next tick.`,
      );
      void this.onClientDropped(client);
    });
    client.on('end', () => {
      void this.onClientDropped(client);
    });
    try {
      await client.connect();
      this.client = client;
      await this.tryAcquire();
    } catch (err) {
      this.log.warn(
        `Leader-election connect/acquire failed: ${
          err instanceof Error ? err.message : err
        }. Staying follower; will retry.`,
      );
      this.isLeader = false;
      this.client = null;
      try {
        await client.end();
      } catch {
        /* best effort */
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Try to take the lock on the current connection. pg advisory
   * locks are re-entrant per session, so we only call this while we
   * are a follower (isLeader stays false until it returns true),
   * which keeps the lock count at exactly one and avoids stacking.
   */
  private async tryAcquire(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS got',
      [LEADER_NAMESPACE, LEADER_SCOPE_CRONS],
    );
    const got = result.rows[0]?.got === true;
    if (got && !this.isLeader) {
      this.isLeader = true;
      this.log.log(
        `Leader lock acquired (namespace=${LEADER_NAMESPACE}, scope=${LEADER_SCOPE_CRONS}); this replica will run cron jobs.`,
      );
    } else if (!got) {
      this.isLeader = false;
    }
  }

  /**
   * Periodic reconciliation. Cheap and idempotent so it is safe to
   * fire on every replica forever.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (!this.client) {
      // Connection gone: reconnect (which reacquires if free).
      await this.connectAndAcquire();
      return;
    }
    if (!this.isLeader) {
      // Live follower: the leader may have gone away; try to take it.
      try {
        await this.tryAcquire();
      } catch (err) {
        this.log.warn(
          `Leader reacquire attempt failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
        await this.onClientDropped(this.client);
      }
      return;
    }
    // We lead: confirm the connection (and therefore the lock) is
    // still alive. A dead connection has already released the lock.
    try {
      await this.client.query('SELECT 1');
    } catch {
      this.log.warn(
        'Leader liveness check failed; the advisory lock is gone. Demoting.',
      );
      await this.onClientDropped(this.client);
    }
  }

  /**
   * Handle a dropped/ended client: demote and clear it so the next
   * tick reconnects. Guarded on identity so a late event from an old
   * client cannot clobber a fresh one.
   */
  private async onClientDropped(from: PgClient): Promise<void> {
    if (this.client && this.client !== from) return;
    this.isLeader = false;
    this.client = null;
    try {
      await from.end();
    } catch {
      /* already gone */
    }
  }

  private async teardownClient(explicitUnlock: boolean): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (explicitUnlock) {
      // Releasing the lock explicitly is optional (closing the
      // connection drops it) but friendlier to a slow-to-disconnect
      // Postgres.
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          LEADER_NAMESPACE,
          LEADER_SCOPE_CRONS,
        ]);
      } catch {
        /* shutting down anyway */
      }
    }
    try {
      await client.end();
    } catch {
      /* shutting down anyway */
    }
  }
}
