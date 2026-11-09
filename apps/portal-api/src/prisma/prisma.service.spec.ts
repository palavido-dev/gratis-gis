// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool } from 'pg';

import { assertAdapterUsesPool } from './prisma.service';

describe('assertAdapterUsesPool', () => {
  it('passes when the adapter resolves the same pg as portal-api', () => {
    // Fails if the lockfile ever resolves two copies of pg, which would
    // make @prisma/adapter-pg ignore the pool PrismaService builds.
    expect(() => assertAdapterUsesPool(Pool)).not.toThrow();
  });

  it('throws when the adapter would see a different Pool class', () => {
    class OtherPool {}
    expect(() => assertAdapterUsesPool(Pool, OtherPool)).toThrow(/different copy of `pg`/);
  });
});
