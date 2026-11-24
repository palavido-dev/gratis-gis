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
      const c = cond as { not?: unknown; lt?: Date; in?: unknown[] };
      if ('not' in c) {
        if (v === null) return false;
        if (c.not !== null && v === c.not) return false;
      }
      if (c.lt !== undefined && !(v instanceof Date && v < c.lt)) return false;
      if (c.in !== undefined && !c.in.includes(v)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

/**
 * In-memory Prisma for the off-site code. Like the real database, it
 * refuses a second backup_run row with offsite_status 'running' (the
 * partial unique index) with P2002.
 */
export function makePrisma(runs: Row[], configRow: Row, objects: Row[] = []) {
  const pickFrom = (
    rows: Row[],
    args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    },
  ) => {
    let out = rows.filter((r) => matches(r, args.where ?? {}));
    if (args.orderBy) {
      const [[field, dir]] = Object.entries(args.orderBy) as [[string, 'asc' | 'desc']];
      out = [...out].sort((a, b) => {
        const av = (a[field] as Date | null)?.getTime() ?? 0;
        const bv = (b[field] as Date | null)?.getTime() ?? 0;
        return dir === 'asc' ? av - bv : bv - av;
      });
    }
    return args.take === undefined ? out : out.slice(0, args.take);
  };
  const pick = (args: Parameters<typeof pickFrom>[1]) => pickFrom(runs, args);
  const assertOneRunning = (changing: Row[], data: Record<string, unknown>) => {
    if (data.offsiteStatus !== 'running') return;
    const others = runs.filter((r) => r.offsiteStatus === 'running' && !changing.includes(r));
    if (others.length + changing.length > 1) {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
  };
  const objectKey = (w: { target: string; name: string }) => `${w.target}\0${w.name}`;
  return {
    backupConfig: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(configRow, data);
        return configRow;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!matches(configRow, where)) return { count: 0 };
          Object.assign(configRow, data);
          return { count: 1 };
        },
      ),
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
          assertOneRunning([r], data);
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
          assertOneRunning(hit, data);
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        },
      ),
    },
    backupOffsiteObject: {
      rows: objects,
      findMany: jest.fn(async (args: Parameters<typeof pickFrom>[1]) => pickFrom(objects, args)),
      upsert: jest.fn(
        async (args: {
          where: { target_name: { target: string; name: string } };
          create: Row;
          update: Record<string, unknown>;
        }) => {
          const k = objectKey(args.where.target_name);
          const hit = objects.find((o) => objectKey(o as never) === k);
          if (hit) Object.assign(hit, args.update);
          else objects.push({ ...args.create, id: k });
          return hit ?? objects.at(-1);
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
          const hit = objects.filter((o) => matches(o, where));
          for (const o of hit) Object.assign(o, data);
          return { count: hit.length };
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const keep = objects.filter((o) => !matches(o, where));
        const n = objects.length - keep.length;
        objects.splice(0, objects.length, ...keep);
        return { count: n };
      }),
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
    offsitePublicKey: null,
    offsiteInstallId: null,
    offsiteNameKeyEncrypted: null,
    offsiteNameKeyIv: null,
    offsiteRetentionDays: null,
    offsiteAlertDays: null,
    offsiteMirrorThresholdBytes: null,
    offsiteSigningKeyEncrypted: null,
    offsiteSigningKeyIv: null,
    offsiteVerifyKey: null,
    offsitePreviousVerifyKeys: [],
    offsiteSigningKeyChangedAt: null,
    offsiteSigningKeyChangedBy: null,
  };
}
