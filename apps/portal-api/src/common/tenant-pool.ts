// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { currentTenant, type TenantContext } from './tenant-context.js';
import { isUuidShape } from './uuid-shape.js';

/**
 * A `pg.Pool` that tells PostgreSQL which organization each connection
 * works for, so row-level security policies can limit what it sees.
 *
 * NOT USED BY THE APPLICATION YET. Nothing in startup or in the request
 * path builds one. It exists so its behaviour can be tested and
 * measured before anything depends on it.
 *
 * How it works:
 *
 * - Every checkout (`connect()` in both its promise and callback forms,
 *   and `query()`, which pg-pool runs through `connect()`) reads the
 *   tenant context synchronously, before anything is awaited.
 * - System work gets a connection from a second pool, logged in as a
 *   role that the policies do not apply to. No settings are written.
 * - Any other work gets a connection from this pool, and three session
 *   settings are written in one statement before the caller sees it:
 *   `gratis.org_id`, `gratis.ctx` and `gratis.user_id`.
 * - No context at all writes ctx `none` and an empty org id. The
 *   policy helpers read an empty org id as NULL, which matches no row.
 * - A connection that already carries exactly the wanted values is
 *   handed out without the extra statement (see `alwaysStamp`).
 * - A connection that comes back from the pool inside a transaction is
 *   destroyed, never reused: a later ROLLBACK would undo the new values
 *   and bring back the previous holder's.
 * - If writing the settings fails, the connection is destroyed and the
 *   checkout fails. The caller never receives an unstamped connection.
 *
 * The values belong to the checkout, not to each query. A connection
 * held across a change of context (an open transaction, a COPY, a
 * client kept by the caller) keeps the values it was handed out with.
 */

/** Names of the session settings. Fixed; never built from input. */
export const TENANT_SETTING_NAMES = {
  orgId: 'gratis.org_id',
  ctx: 'gratis.ctx',
  userId: 'gratis.user_id',
} as const;

/** Values `gratis.ctx` can take. `guest` is reserved for later use. */
export type StampContext = 'org' | 'anonymous' | 'guest' | 'none';

/** What a connection is stamped with. Empty strings mean "not set". */
export interface TenantStamp {
  readonly orgId: string;
  readonly ctx: StampContext;
  readonly userId: string;
}

/** The statement that writes the stamp. One round trip. */
export const STAMP_SQL =
  "SELECT set_config('gratis.org_id', $1, false), " +
  "set_config('gratis.ctx', $2, false), " +
  "set_config('gratis.user_id', $3, false)";

const NONE: TenantStamp = Object.freeze({ orgId: '', ctx: 'none', userId: '' });
const ANONYMOUS: TenantStamp = Object.freeze({ orgId: '', ctx: 'anonymous', userId: '' });

/**
 * The stamp for a context, or `'system'` when the work must use the
 * system pool. Throws when an org or user id is not UUID-shaped: the
 * policy helpers cast them to uuid, so a bad value would make every
 * query fail later with a less clear error.
 */
export function stampForContext(ctx: TenantContext | undefined): TenantStamp | 'system' {
  if (ctx === undefined) return NONE;
  switch (ctx.kind) {
    case 'org': {
      if (!isUuidShape(ctx.orgId)) {
        throw new TypeError('Tenant context carries an org id that is not a UUID');
      }
      const userId = ctx.userId ?? '';
      if (userId !== '' && !isUuidShape(userId)) {
        throw new TypeError('Tenant context carries a user id that is not a UUID');
      }
      return { orgId: ctx.orgId, ctx: 'org', userId };
    }
    case 'anonymous':
      return ANONYMOUS;
    case 'system':
      return 'system';
    default: {
      // A new variant must be mapped above. Until it is, it gets no
      // rows rather than some.
      const unhandled: never = ctx;
      void unhandled;
      return NONE;
    }
  }
}

function stampKey(stamp: TenantStamp): string {
  return `${stamp.ctx}|${stamp.orgId}|${stamp.userId}`;
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

/** pg 8.x Client exposes the transaction status from ReadyForQuery. */
type ClientWithTxStatus = PoolClient & { getTransactionStatus?: () => string | null };

export interface TenantPoolOptions {
  /**
   * Pool for system work, logged in as a role the policies do not
   * apply to. Without it, a checkout under a system context fails.
   */
  systemPool?: Pool;
  /**
   * Write the stamp on every checkout, even when the connection
   * already carries the same values. Costs one round trip per
   * checkout; protects against code that changed the settings by hand.
   */
  alwaysStamp?: boolean;
}

/** How many non-idle connections a checkout throws away before giving up. */
const MAX_DIRTY_RETRIES = 3;

export class TenantPool extends Pool {
  private readonly systemPool: Pool | undefined;
  private readonly alwaysStamp: boolean;
  /** Stamp each live connection carries, as far as this pool knows. */
  private readonly stamps = new WeakMap<object, string>();
  /** Counters for tests and measurements. */
  readonly counters = { checkouts: 0, stamped: 0, skipped: 0, system: 0, dirty: 0, failed: 0 };

  constructor(config: PoolConfig, options: TenantPoolOptions = {}) {
    super(config);
    this.systemPool = options.systemPool;
    this.alwaysStamp = options.alwaysStamp === true;
    // pg-pool emits 'error' for idle clients that lose their
    // connection. Pass the system pool's on to this pool's listeners
    // so one listener (the Prisma adapter adds one) covers both.
    this.systemPool?.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
  }

  /** The stamp key this pool last wrote on `client`, for tests. */
  stampOf(client: PoolClient): string | undefined {
    return this.stamps.get(client);
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    // Read the context now, before any await, so a connection that
    // becomes free later is stamped for the caller that asked for it,
    // not for whatever runs when the pool hands it over.
    let wanted: TenantStamp | 'system';
    try {
      wanted = stampForContext(currentTenant());
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!callback) return Promise.reject(error);
      process.nextTick(() => callback(error, undefined, () => {}));
      return;
    }
    const checkout = this.checkout(wanted);
    if (!callback) return checkout;
    checkout.then(
      (client) =>
        callback(undefined, client, (release?: unknown) => client.release(release as Error)),
      (err: unknown) =>
        callback(err instanceof Error ? err : new Error(String(err)), undefined, () => {}),
    );
  }

  override async end(): Promise<void> {
    await super.end();
    if (this.systemPool && !this.systemPool.ended) await this.systemPool.end();
  }

  private async checkout(wanted: TenantStamp | 'system'): Promise<PoolClient> {
    this.counters.checkouts += 1;
    if (wanted === 'system') {
      if (!this.systemPool) {
        throw new Error('System work needs a system database connection, and none is set up.');
      }
      this.counters.system += 1;
      return this.systemPool.connect();
    }
    const key = stampKey(wanted);
    for (let attempt = 0; attempt <= MAX_DIRTY_RETRIES; attempt += 1) {
      const client = await super.connect();
      const status = (client as ClientWithTxStatus).getTransactionStatus?.() ?? 'I';
      if (status !== 'I') {
        // Returned inside a transaction. Destroy it: a later ROLLBACK
        // there would undo the stamp we are about to write.
        this.counters.dirty += 1;
        this.stamps.delete(client);
        client.release(new Error('connection returned inside a transaction'));
        continue;
      }
      if (!this.alwaysStamp && this.stamps.get(client) === key) {
        this.counters.skipped += 1;
        return client;
      }
      // Forget the old stamp first: if the write below fails half way,
      // nothing may believe the connection still carries it.
      this.stamps.delete(client);
      try {
        await client.query(STAMP_SQL, [wanted.orgId, wanted.ctx, wanted.userId]);
      } catch (err) {
        this.counters.failed += 1;
        client.release(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
      this.stamps.set(client, key);
      this.counters.stamped += 1;
      return client;
    }
    throw new Error('Could not get a database connection outside a transaction.');
  }
}
