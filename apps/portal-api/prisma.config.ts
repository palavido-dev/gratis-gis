// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prisma 7 config. Prisma 7 moved the connection URL out of
// schema.prisma and into this file for the CLI / migrate
// workflow. The runtime PrismaClient constructor reads its
// connection separately via a Driver Adapter (see
// src/prisma/prisma.service.ts).
//
// The schema and migrations directories are explicit so we can
// invoke `pnpm prisma migrate dev` from the repo root or from
// inside apps/portal-api without surprises.

import path from 'node:path';
import fs from 'node:fs';
import { defineConfig } from 'prisma/config';

// In local dev, load DATABASE_URL from .env if present. Don't
// require dotenv as a dep -- it's a dev-only convenience; runtime
// (container) env-vars come from docker compose. We parse .env
// inline so the production image, which prunes devDeps, doesn't
// crash on a missing `dotenv/config` module at every entrypoint
// invocation of `prisma migrate deploy`.
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath) && !process.env.DATABASE_URL) {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (m) {
      // Strip optional surrounding quotes.
      const v = (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
      if (v) process.env.DATABASE_URL = v;
      break;
    }
  }
}

// DATABASE_URL is read at config-load time but not required for
// every Prisma operation. `prisma generate` only emits the client
// from the schema and never touches the database; `migrate`,
// `pull`, `push`, etc. do need it and Prisma will surface its own
// "no database URL" error at those touchpoints. By passing
// `undefined` here when DATABASE_URL is absent we let `generate`
// succeed (which matters during the Docker build phase where the
// container has no DB connection yet) while the runtime + migrate
// paths still fail loudly if the env-var is missing later.
const databaseUrl = process.env.DATABASE_URL;
// Only `migrate dev` and `migrate diff --from-migrations` (the CI
// schema drift check) need a shadow database.
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  ...(databaseUrl
    ? {
        datasource: {
          url: databaseUrl,
          ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
        },
      }
    : {}),
});
