// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory stand-ins for the Prisma calls the off-site backup code
 * makes. Test helper only.
 */
export type Row = Record<string, unknown> & { id: string };

/** Enough of Prisma's where language for the queries the service makes. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Record<string, unknown>[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k] ?? null;
    if (cond === null) {
      if (v !== null) return false;
    } else if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; lt?: Date };
      if ('not' in c) {
        if (v === null) return false;
        if (c.not === null ? v === null : v === c.not) return false;
      }
      if (c.lt !== undefined && !(v instanceof Date && v < c.lt)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

export function makePrisma(runs: Row[], configRow: Row) {
  const pick = (args: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }) => {
    let rows = runs.filter((r) => matches(r, args.where ?? {}));
    if (args.orderBy) {
      const [[field, dir]] = Object.entries(args.orderBy) as [[string, 'asc' | 'desc']];
      rows = [...rows].sort((a, b) => {
        const av = (a[field] as Date | null)?.getTime() ?? 0;
        const bv = (b[field] as Date | null)?.getTime() ?? 0;
        return dir === 'asc' ? av - bv : bv - av;
      });
    }
    return rows;
  };
  return {
    backupConfig: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(configRow, data);
        return configRow;
      }),
    },
    backupRun: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => runs.find((r) => r.id === where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
        return r;
      }),
      findFirst: jest.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'>;
        }) => pick(args)[0] ?? null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = runs.find((x) => x.id === where.id);
          if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
          Object.assign(r, data);
          return r;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = runs.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        },
      ),
    },
  };
}

export function emptyConfigRow(): Row {
  return {
    id: 'cfg',
    offsiteEnabled: null,
    offsiteEndpoint: null,
    offsiteRegion: null,
    offsiteBucket: null,
    offsitePrefix: null,
    offsitePathStyle: null,
    offsiteAccessKeyId: null,
    offsiteSecretEncrypted: null,
    offsiteSecretIv: null,
    offsitePassphraseEncrypted: null,
    offsitePassphraseIv: null,
    offsiteRetentionDays: null,
    offsiteAlertDays: null,
    offsiteMirrorThresholdBytes: null,
  };
}
