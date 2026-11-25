// SPDX-License-Identifier: AGPL-3.0-or-later
import { runAsSystem } from './tenant-context.js';
import { STAMP_SQL, TENANT_SETTING_NAMES, TenantPool, stampForContext } from './tenant-pool.js';

const ORG = '51000000-0000-4000-8000-00000000000a';
const USER = '51000000-0000-4000-8000-0000000000a1';

describe('stampForContext', () => {
  it('no context stamps none with no org', () => {
    expect(stampForContext(undefined)).toEqual({ orgId: '', ctx: 'none', userId: '' });
  });

  it('an org context stamps its org and user', () => {
    expect(stampForContext({ kind: 'org', orgId: ORG, userId: USER })).toEqual({
      orgId: ORG,
      ctx: 'org',
      userId: USER,
    });
    expect(stampForContext({ kind: 'org', orgId: ORG })).toEqual({
      orgId: ORG,
      ctx: 'org',
      userId: '',
    });
  });

  it('anonymous stamps no org', () => {
    expect(stampForContext({ kind: 'anonymous' })).toEqual({
      orgId: '',
      ctx: 'anonymous',
      userId: '',
    });
  });

  it('system work goes to the system pool', () => {
    expect(stampForContext({ kind: 'system', reason: 'job-claim' })).toBe('system');
  });

  it('refuses ids that are not UUIDs', () => {
    expect(() => stampForContext({ kind: 'org', orgId: "x' OR true" })).toThrow(/not a UUID/);
    expect(() => stampForContext({ kind: 'org', orgId: ORG, userId: 'u1' })).toThrow(/not a UUID/);
  });

  it('writes the three fixed settings in one statement', () => {
    for (const name of Object.values(TENANT_SETTING_NAMES))
      expect(STAMP_SQL).toContain(`'${name}'`);
    expect(STAMP_SQL.match(/set_config/g)).toHaveLength(3);
  });
});

describe('TenantPool without a system pool', () => {
  it('fails a system checkout instead of using the app login', async () => {
    const pool = new TenantPool({
      connectionString: 'postgresql://nobody@127.0.0.1:1/none',
      max: 1,
    });
    try {
      await expect(runAsSystem('test', () => pool.connect())).rejects.toThrow(
        /system database connection/,
      );
    } finally {
      await pool.end();
    }
  });
});
