// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrismaService } from '../prisma/prisma.service.js';
import { legacyKeyCounters } from '../storage/object-keys.js';
import { LEDGER_FILLED_SETTING } from '../storage/storage-ledger.service.js';
import { MetricsService } from './metrics.service.js';

/** Any model call resolves empty; system_setting answers from `settings`. */
function prismaWith(settings: Record<string, unknown>): PrismaService {
  const any: unknown = new Proxy(() => undefined, {
    get: (_t, prop) => (prop === 'then' ? undefined : any),
    apply: () => Promise.resolve([]),
  });
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'systemSetting'
          ? {
              findUnique: async ({ where }: { where: { key: string } }) =>
                where.key in settings ? { key: where.key, value: settings[where.key] } : null,
            }
          : any,
    },
  ) as PrismaService;
}

function line(text: string, name: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(`${name} `));
}

describe('storage owner check metrics', () => {
  it('reports the first fill as pending until the marker exists', async () => {
    const pending = new MetricsService(prismaWith({}), null, null);
    pending.enable();
    expect(line(await pending.render(), 'gratisgis_storage_usage_first_fill_pending')).toBe(
      'gratisgis_storage_usage_first_fill_pending 1',
    );
    const done = new MetricsService(
      prismaWith({ [LEDGER_FILLED_SETTING]: { at: 'x' } }),
      null,
      null,
    );
    done.enable();
    expect(line(await done.render(), 'gratisgis_storage_usage_first_fill_pending')).toBe(
      'gratisgis_storage_usage_first_fill_pending 0',
    );
  });

  it('counts refused and passed older keys', async () => {
    const m = new MetricsService(prismaWith({}), null, null);
    m.enable();
    const before = legacyKeyCounters.refusedNoRow;
    legacyKeyCounters.refusedNoRow += 2;
    try {
      const text = await m.render();
      expect(line(text, 'gratisgis_storage_legacy_key_refusals_total')).toBe(
        `gratisgis_storage_legacy_key_refusals_total ${before + 2}`,
      );
      expect(line(text, 'gratisgis_storage_legacy_key_unfilled_passes_total')).toBeDefined();
    } finally {
      legacyKeyCounters.refusedNoRow = before;
    }
  });
});
