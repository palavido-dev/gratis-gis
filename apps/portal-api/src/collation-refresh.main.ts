// SPDX-License-Identifier: AGPL-3.0-or-later
import { Client } from 'pg';

import { refreshCollations } from './maintenance/collation-refresh.js';
import { writeStartupStatus } from './startup-status.js';

/**
 * One-shot run before `prisma migrate deploy` (docker-entrypoint.sh
 * and the portal-migrate service). See maintenance/collation-refresh.ts.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const result = await refreshCollations(
    async (database) => {
      const target = new URL(url);
      if (database !== null) target.pathname = `/${encodeURIComponent(database)}`;
      // No time limit for this connection. The app role carries a 30 s
      // statement_timeout (migration 20260518150000) so one bad query
      // cannot hang the portal, but REINDEX DATABASE on a few GB of
      // layers takes minutes, and hitting the limit left the API
      // refusing to start on every try (#766). Same exemption as the
      // migrate step (prisma.config.ts).
      const client = new Client({
        connectionString: target.toString(),
        options: '-c statement_timeout=0 -c lock_timeout=0',
      });
      await client.connect();
      return client;
    },
    (line) => {
      console.log(`[collation] ${line}`);
      // The slow case: tell the status page which database is being
      // rebuilt, so a long wait does not look like a hang.
      const rebuilding = /^collation version changed in (.+): rebuilding its indexes$/.exec(line);
      if (rebuilding) writeStartupStatus('database-rebuild', { detail: rebuilding[1] });
    },
  );
  if (!result.skipped && result.reindexed.length === 0 && result.postgisUpgraded.length === 0) {
    console.log('[collation] all databases current');
  }
}

main().catch((err: unknown) => {
  console.error(
    '[collation] FAILED. The app will not start on indexes it cannot trust. ' +
      'See docs/UPGRADING.md, "Postgres base image moved to Debian trixie".',
  );
  console.error(err);
  process.exit(1);
});
