// SPDX-License-Identifier: AGPL-3.0-or-later
import { ServiceUnavailableException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service';
import { runAsOrg } from '../common/tenant-context';
import { resetTenancyModeForTests } from '../common/tenancy';

import { readReportTemplate, reportFileName, ReportsService } from './reports.service';

const user = { id: 'u1', orgId: 'o1' } as unknown as AuthUser;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function setup() {
  const layerItem = {
    id: 'dl',
    type: 'data_layer',
    title: 'Inspections',
    data: {
      version: 3,
      layers: [
        {
          id: 'insp',
          fields: [
            { name: 'site', type: 'string', label: 'Site', nullable: true },
            {
              name: 'status',
              type: 'string',
              label: 'Status',
              nullable: true,
              domain: { type: 'coded-value', values: [{ code: 'ok', label: 'Passed' }] },
            },
          ],
        },
      ],
    },
  };
  const rows: Record<string, Record<string, unknown>> = {
    [A]: { '{{site}}': 'North <gate>', '{{status}}': 'ok', "concat('n=', 1)": 'n=1' },
    [B]: { '{{site}}': 'South', '{{status}}': 'bad', "concat('n=', 1)": 'n=1' },
  };
  const evaluate = jest.fn(
    async (args: {
      expressions: Record<string, string>;
      featureIds?: string[];
      limit?: number;
    }) => {
      const keys = Object.keys(args.expressions);
      const ids = args.featureIds ?? Object.keys(rows).slice(0, args.limit ?? 1);
      return {
        expressions: keys.map((key) => ({
          key,
          type: 'text',
          issues: args.expressions[key] === 'nope(' ? [{ message: 'Syntax error' }] : [],
        })),
        rows: ids
          .filter((id) => rows[id])
          .map((id) => ({ id, values: keys.map((k) => rows[id]![args.expressions[k]!] ?? null) })),
      };
    },
  );
  const svc = new ReportsService(
    { get: jest.fn(async () => layerItem) } as never,
    {} as never,
    { layerOf: jest.fn(), evaluate } as never,
    {} as never,
    {} as never,
  );
  return { svc, evaluate };
}

describe('ReportsService.fill', () => {
  it('fills fields with labels and escapes values, in the requested order', async () => {
    const t = setup();
    const res = await t.svc.fill(
      user,
      { itemId: 'dl', layerKey: 'insp' },
      "# {{site}}\n\nStatus: {{status}} {{= concat('n=', 1) }} {{missing}}",
      { featureIds: [B, A] },
    );
    expect(res.features.map((f) => f.id)).toEqual([B, A]);
    expect(res.features[1]!.html).toContain('<h1>North &lt;gate&gt;</h1>');
    expect(res.features[1]!.html).toContain('Status: Passed n=1');
    expect(res.features[0]!.html).toContain('Status: bad');
    expect(res.issues).toEqual(['{{missing}} is not a field on this layer.']);
  });

  it('reports expression errors once and previews the first feature', async () => {
    const t = setup();
    const res = await t.svc.fill(user, { itemId: 'dl', layerKey: 'insp' }, '{{= nope( }}', {
      limit: 1,
    });
    expect(res.features).toHaveLength(1);
    expect(res.issues).toEqual(['{{= nope(}}: Syntax error']);
  });

  it('notes features that could not be read', async () => {
    const t = setup();
    const res = await t.svc.fill(user, { itemId: 'dl', layerKey: 'insp' }, '{{site}}', {
      featureIds: [A, '33333333-3333-3333-3333-333333333333'],
    });
    expect(res.features).toHaveLength(1);
    expect(res.issues[0]).toMatch(/1 of the selected features/);
  });
});

describe('readReportTemplate and reportFileName', () => {
  it('needs a layer and defaults the page', () => {
    expect(() => readReportTemplate({ body: 'x' })).toThrow(/no layer/);
    expect(
      readReportTemplate({ sources: [{ itemId: 'a', layerKey: 'b' }], page: { size: 'huge' } })
        .page,
    ).toEqual({
      size: 'letter',
      orientation: 'portrait',
    });
  });
  it('cleans file names', () => {
    expect(reportFileName('Site / "North" inspections')).toBe('Site North inspections.pdf');
    expect(reportFileName('***')).toBe('report.pdf');
  });
});

describe.each(['single', 'multi'] as const)('ReportsService.pdf render limit, %s tenancy', (mode) => {
  const before = {
    tenancy: process.env.GRATIS_TENANCY,
    endpoints: process.env.CHROMIUM_WS_ENDPOINTS,
  };
  beforeEach(() => {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    // Nothing listens there: a render that gets a slot fails to connect.
    process.env.CHROMIUM_WS_ENDPOINTS = 'ws://127.0.0.1:1';
    resetTenancyModeForTests();
  });
  afterEach(() => {
    for (const [k, v] of [
      ['GRATIS_TENANCY', before.tenancy],
      ['CHROMIUM_WS_ENDPOINTS', before.endpoints],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetTenancyModeForTests();
  });

  const page = { size: 'letter', orientation: 'portrait' } as Parameters<ReportsService['pdf']>[1];

  it('turns a render away when two are running, whichever organization asks', async () => {
    const { svc } = setup();
    const running = svc as unknown as { signedInRenders: number };
    running.signedInRenders = 2;
    const err = await runAsOrg('org-b', () => svc.pdf('<p></p>', page)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe('The report service is busy. Try again in a minute.');
    expect(running.signedInRenders).toBe(2);
  });

  it('takes the second slot and gives it back when the render fails', async () => {
    const { svc } = setup();
    const running = svc as unknown as { signedInRenders: number };
    running.signedInRenders = 1;
    const err = await runAsOrg('org-b', () => svc.pdf('<p></p>', page)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    expect(running.signedInRenders).toBe(1);
  });
});

describe('ReportsService.pdf signed-in and anonymous pools', () => {
  const before = process.env.CHROMIUM_WS_ENDPOINTS;
  beforeEach(() => {
    process.env.CHROMIUM_WS_ENDPOINTS = 'ws://chromium:3000';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.CHROMIUM_WS_ENDPOINTS;
    else process.env.CHROMIUM_WS_ENDPOINTS = before;
  });

  const page = { size: 'letter', orientation: 'portrait' } as Parameters<ReportsService['pdf']>[1];
  const BUSY = 'The report service is busy. Try again in a minute.';

  /**
   * A service whose Chromium is a stand-in. Each render waits on
   * `setContent` until the test lets it go, so slots can be held.
   */
  function rig(opts: { connectFails?: boolean; renderFails?: boolean } = {}) {
    const holds: Array<() => void> = [];
    const tabs: Array<{ close: jest.Mock; setContent: jest.Mock; pdf: jest.Mock }> = [];
    const disconnect = jest.fn(async () => undefined);
    class Stubbed extends ReportsService {
      protected override connect() {
        if (opts.connectFails) return Promise.reject(new Error('connect refused'));
        return Promise.resolve({
          newPage: async () => {
            const tab = {
              setJavaScriptEnabled: jest.fn(async () => undefined),
              setRequestInterception: jest.fn(async () => undefined),
              on: jest.fn(),
              setContent: jest.fn(
                () =>
                  new Promise<void>((resolve, reject) =>
                    holds.push(() =>
                      opts.renderFails ? reject(new Error('timed out')) : resolve(),
                    ),
                  ),
              ),
              pdf: jest.fn(async () => new Uint8Array([37, 80, 68, 70])),
              close: jest.fn(async () => undefined),
            };
            tabs.push(tab);
            return tab;
          },
          disconnect,
        } as never);
      }
    }
    const svc = new Stubbed({} as never, {} as never, {} as never, {} as never, {} as never);
    const slots = svc as unknown as { signedInRenders: number; anonymousRenders: number };
    const started = () => tabs.filter((t) => t.setContent.mock.calls.length > 0).length;
    // Let queued promise steps run until every started render is waiting.
    const settle = () => new Promise((r) => setImmediate(r));
    const releaseAll = async () => {
      while (holds.length > 0) holds.shift()!();
      await settle();
    };
    return { svc, slots, tabs, disconnect, started, settle, releaseAll };
  }

  it('still starts a signed-in render while the anonymous slot is busy', async () => {
    const t = rig();
    const anon = t.svc.pdf('<p></p>', page, { anonymous: true });
    await t.settle();
    expect(t.slots.anonymousRenders).toBe(1);

    const second = await t.svc.pdf('<p></p>', page, { anonymous: true }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ServiceUnavailableException);
    expect((second as Error).message).toBe(BUSY);

    const signedIn = t.svc.pdf('<p></p>', page);
    await t.settle();
    expect(t.slots.signedInRenders).toBe(1);
    expect(t.started()).toBe(2);

    await t.releaseAll();
    await expect(anon).resolves.toBeInstanceOf(Buffer);
    await expect(signedIn).resolves.toBeInstanceOf(Buffer);
    expect(t.slots).toMatchObject({ signedInRenders: 0, anonymousRenders: 0 });
  });

  it('still starts an anonymous render while both signed-in slots are busy', async () => {
    const t = rig();
    const a = t.svc.pdf('<p></p>', page);
    const b = t.svc.pdf('<p></p>', page);
    await t.settle();
    expect(t.slots.signedInRenders).toBe(2);

    const anon = t.svc.pdf('<p></p>', page, { anonymous: true });
    await t.settle();
    expect(t.slots.anonymousRenders).toBe(1);
    expect(t.started()).toBe(3);

    const third = await t.svc.pdf('<p></p>', page).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(ServiceUnavailableException);
    expect((third as Error).message).toBe(BUSY);

    await t.releaseAll();
    await Promise.all([a, b, anon]);
    expect(t.slots).toMatchObject({ signedInRenders: 0, anonymousRenders: 0 });
  });

  it.each([false, true])(
    'gives the slot back after a render that works (anonymous %s)',
    async (anonymous) => {
      const t = rig();
      const done = t.svc.pdf('<p></p>', page, { anonymous });
      await t.settle();
      await t.releaseAll();
      await expect(done).resolves.toEqual(Buffer.from('%PDF'));
      expect(t.slots).toMatchObject({ signedInRenders: 0, anonymousRenders: 0 });
      expect(t.tabs[0]!.close).toHaveBeenCalled();
      expect(t.disconnect).toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'gives the slot back and closes the tab when a render fails (anonymous %s)',
    async (anonymous) => {
      const t = rig({ renderFails: true });
      const done = t.svc.pdf('<p></p>', page, { anonymous }).catch((e: unknown) => e);
      await t.settle();
      await t.releaseAll();
      expect(((await done) as Error).message).toBe('timed out');
      expect(t.slots).toMatchObject({ signedInRenders: 0, anonymousRenders: 0 });
      expect(t.tabs[0]!.close).toHaveBeenCalled();
      expect(t.tabs[0]!.pdf).not.toHaveBeenCalled();
      expect(t.disconnect).toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'gives the slot back when Chromium cannot be reached (anonymous %s)',
    async (anonymous) => {
      const t = rig({ connectFails: true });
      const err = await t.svc.pdf('<p></p>', page, { anonymous }).catch((e: unknown) => e);
      expect((err as Error).message).toBe('connect refused');
      expect(t.slots).toMatchObject({ signedInRenders: 0, anonymousRenders: 0 });
    },
  );

  it('gives anonymous renders shorter time limits than signed-in ones', async () => {
    const t = rig();
    const signedIn = t.svc.pdf('<p></p>', page);
    const anon = t.svc.pdf('<p></p>', page, { anonymous: true });
    await t.settle();
    await t.releaseAll();
    await Promise.all([signedIn, anon]);
    const [s, a] = t.tabs;
    expect(s!.setContent.mock.calls[0]![1]).toMatchObject({ timeout: 60_000 });
    expect(s!.pdf.mock.calls[0]![0]).toMatchObject({ timeout: 120_000 });
    expect(a!.setContent.mock.calls[0]![1]).toMatchObject({ timeout: 20_000 });
    expect(a!.pdf.mock.calls[0]![0]).toMatchObject({ timeout: 40_000 });
  });
});
