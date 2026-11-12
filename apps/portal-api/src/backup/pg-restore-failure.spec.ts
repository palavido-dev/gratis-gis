// SPDX-License-Identifier: AGPL-3.0-or-later
import { pgRestoreFailure, restoreSpaceNeeded } from './backup-restore.service.js';

const inherited = (n: string) =>
  `pg_restore: error: could not execute query: ERROR:  cannot drop inherited constraint "observation_p${n}_pkey" of relation "observation_p${n}"\n` +
  `Command was: ALTER TABLE IF EXISTS ONLY public.observation_p${n} DROP CONSTRAINT IF EXISTS observation_p${n}_pkey;\n`;

describe('pgRestoreFailure', () => {
  it('accepts a clean exit', () => {
    expect(pgRestoreFailure(0, '')).toBeNull();
  });

  it('accepts exit 1 when every error is the known partition one', () => {
    const err = inherited('202501') + inherited('202502') +
      'pg_restore: warning: errors ignored on restore: 2\n';
    expect(pgRestoreFailure(1, err)).toBeNull();
  });

  it('fails when any other error is among them', () => {
    const err = inherited('202501') +
      'pg_restore: error: could not execute query: ERROR:  relation "item" does not exist\n' +
      'pg_restore: warning: errors ignored on restore: 2\n';
    expect(pgRestoreFailure(1, err)).toMatch(/relation "item" does not exist/);
  });

  it('fails when the ignored count is more than the errors it could read', () => {
    const err = inherited('202501') + 'pg_restore: warning: errors ignored on restore: 3\n';
    expect(pgRestoreFailure(1, err)).toMatch(/does not match/);
  });

  it('fails on exit 1 with no error lines, and on any other exit code', () => {
    expect(pgRestoreFailure(1, 'pg_restore: fatal\n')).not.toBeNull();
    expect(pgRestoreFailure(2, inherited('202501'))).not.toBeNull();
  });
});

describe('restoreSpaceNeeded', () => {
  it('counts the bucket and the archive with headroom', () => {
    const gb = 1024 ** 3;
    expect(restoreSpaceNeeded(10 * gb, 2 * gb)).toBeGreaterThan(12 * gb);
    expect(restoreSpaceNeeded(0, 0)).toBe(64 * 1024 * 1024);
  });
});
