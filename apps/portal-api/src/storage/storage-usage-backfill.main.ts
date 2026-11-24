// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fill the storage usage ledger for objects stored before it existed.
// The daily reconcile does the same work; this runs it on demand, in
// pages, and can stop and resume.
//
//   node dist/storage/storage-usage-backfill.main.js            # dry run: report only
//   node dist/storage/storage-usage-backfill.main.js --apply    # write the ledger
//   ... --apply --pages 50     # stop after 50 pages of 1000 keys; run again to resume
//   ... --restart              # forget the saved resume point
//
// Reads DATABASE_URL and the MINIO_* settings the API uses. Nothing in
// the bucket is moved, changed or deleted, in any mode. A second
// applied run over an unchanged bucket changes nothing.
import { ConfigService } from '@nestjs/config';

import { runAsSystem } from '../common/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageLedgerService } from './storage-ledger.service.js';
import {
  BACKFILL_CURSOR_SETTING,
  StorageUsageReconcileService,
} from './storage-usage-reconcile.service.js';
import { StorageService } from './storage.service.js';

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function pagesArg(): number | undefined {
  const at = process.argv.indexOf('--pages');
  if (at === -1) return undefined;
  const n = Number(process.argv[at + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error('--pages needs a positive whole number');
  return n;
}

async function main(): Promise<void> {
  const apply = flag('--apply');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const ledger = new StorageLedgerService(prisma);
    const storage = new StorageService(new ConfigService(), ledger);
    const reconcile = new StorageUsageReconcileService(prisma, storage, ledger);
    if (flag('--restart')) {
      await prisma.systemSetting.deleteMany({ where: { key: BACKFILL_CURSOR_SETTING } });
    }
    const saved = await prisma.systemSetting.findUnique({ where: { key: BACKFILL_CURSOR_SETTING } });
    const startAfter = (saved?.value as { after?: string } | undefined)?.after;
    if (startAfter) console.log(`[usage-backfill] resuming after ${startAfter}`);
    const maxPages = pagesArg();
    const summary = await runAsSystem('script:storage-usage-backfill', () =>
      reconcile.reconcile({
        dryRun: !apply,
        ...(startAfter ? { startAfter } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        log: (line) => console.log(`[usage-backfill] ${line}`),
      }),
    );
    if (apply) {
      if (summary.resumeAfter) {
        const value = { after: summary.resumeAfter };
        await prisma.systemSetting.upsert({
          where: { key: BACKFILL_CURSOR_SETTING },
          create: { key: BACKFILL_CURSOR_SETTING, value },
          update: { value },
        });
        console.log(`[usage-backfill] stopped after ${summary.resumeAfter}; run again to continue`);
      } else {
        await prisma.systemSetting.deleteMany({ where: { key: BACKFILL_CURSOR_SETTING } });
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) console.log('[usage-backfill] dry run: nothing was written. Add --apply to write.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`[usage-backfill] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
