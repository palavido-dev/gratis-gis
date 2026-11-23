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
      const client = new Client({ connectionString: target.toString() });
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
