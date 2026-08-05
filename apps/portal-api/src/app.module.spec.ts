// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boot-time dependency-injection smoke test.
//
// Why this file exists: on 2026-08-05 the v0.9.8 deploy took both
// production API replicas down with
//
//   Nest can't resolve dependencies of the JwtAuthGuard (Reflector, ?).
//   Please make sure that the argument ApiKeyService at index [1] is
//   available in the GeocodingModule context.
//
// The change that caused it was adding a constructor dependency to
// `JwtAuthGuard`. Nest instantiates a guard referenced by CLASS in
// `@UseGuards(...)` inside the module context of the CONTROLLER using
// it, so every one of the ~25 modules applying that guard silently
// gained a new provider requirement. `pnpm typecheck` passed. All 1013
// unit tests passed. The failure is only observable when Nest actually
// resolves the graph, which happens at application boot and nowhere
// earlier.
//
// So this test compiles the real AppModule. It deliberately does NOT
// enumerate modules to check: a hand-maintained list would not have
// included GeocodingModule, and would not include whichever module
// trips next time. Importing AppModule means any module added later is
// covered without anyone remembering to add it here.
//
// `compile()` resolves and instantiates the provider graph but does not
// run lifecycle hooks (`onModuleInit`), which is where this codebase
// opens sockets: Prisma connects, MinIO checks buckets, the leader
// election starts polling. That is the line this test rides: full DI
// resolution, no I/O. Do not call `init()` here.

import { Test } from '@nestjs/testing';

import { AppModule } from './app.module.js';

// The real module reads configuration at construction time. These are
// syntactically valid throwaways: nothing here connects anywhere,
// because no lifecycle hook runs, but a missing variable can make a
// provider factory throw and mask the DI result this test is after.
const CONFIG_FOR_CONSTRUCTION: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  KEYCLOAK_ISSUER: 'http://localhost:8081/realms/gratis-gis',
  KEYCLOAK_JWKS_URI:
    'http://localhost:8081/realms/gratis-gis/protocol/openid-connect/certs',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test',
  S3_BUCKET: 'gratisgis',
};

describe('AppModule dependency graph', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(CONFIG_FOR_CONSTRUCTION)) {
      saved[k] = process.env[k];
      if (process.env[k] === undefined) process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves every provider, so the app can actually boot', async () => {
    // A failure here reads exactly like the production crash loop:
    // "Nest can't resolve dependencies of the X (?). Please make sure
    // that the argument Y at index [n] is available in the Z context."
    // The named module Z is the one missing an import, or the sign that
    // the provider should live in a @Global() module.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 120_000);
});
