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
    const running = svc as unknown as { activeRenders: number };
    running.activeRenders = 2;
    const err = await runAsOrg('org-b', () => svc.pdf('<p></p>', page)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe('The report service is busy. Try again in a minute.');
    expect(running.activeRenders).toBe(2);
  });

  it('takes the second slot and gives it back when the render fails', async () => {
    const { svc } = setup();
    const running = svc as unknown as { activeRenders: number };
    running.activeRenders = 1;
    const err = await runAsOrg('org-b', () => svc.pdf('<p></p>', page)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    expect(running.activeRenders).toBe(1);
  });
});
