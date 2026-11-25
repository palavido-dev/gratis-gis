// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { runAsOrg } from '../common/tenant-context.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import { assertPrintTemplateData, clampMarginIn, printTemplatePaper } from './print-paper.js';
import { PrintRenderService } from './print-render.service.js';

describe('print template paper', () => {
  it('reads a known size and orientation', () => {
    expect(printTemplatePaper({ paper: { size: 'a4', orientation: 'landscape' } })).toEqual({
      size: 'a4',
      orientation: 'landscape',
      inches: { w: 11.69, h: 8.27 },
      marginIn: 0.25,
    });
  });

  it('prints on portrait Letter when the template has no paper settings', () => {
    expect(printTemplatePaper({}).inches).toEqual({ w: 8.5, h: 11 });
    expect(printTemplatePaper(null).size).toBe('letter');
    expect(printTemplatePaper({ paper: { size: 'legal' } }).orientation).toBe('portrait');
  });

  it.each([
    ['an unknown size', { paper: { size: 'poster' } }],
    ['a name that is not a size', { paper: { size: 'constructor' } }],
    ['no size', { paper: { orientation: 'portrait' } }],
    ['paper that is not an object', { paper: 'letter' }],
  ])('refuses %s with a 400, at save and at print', (_label, data) => {
    expect(() => printTemplatePaper(data)).toThrow(BadRequestException);
    expect(() => assertPrintTemplateData(data)).toThrow(BadRequestException);
  });

  it.each(['sideways', 7, null, ''])(
    'an unknown orientation (%p) is refused at save and prints portrait',
    (orientation) => {
      const data = { paper: { size: 'letter', orientation } };
      expect(() => assertPrintTemplateData(data)).toThrow(BadRequestException);
      const paper = printTemplatePaper(data);
      expect(paper.orientation).toBe('portrait');
      expect(paper.inches).toEqual({ w: 8.5, h: 11 });
    },
  );

  it.each([
    [-1, 0],
    [-1e9, 0],
    [0.5, 0.5],
    [1e9, 8.5 / 4],
    [Number.NaN, 0.25],
    ['wide', 0.25],
    [undefined, 0.25],
  ])('a margin of %p prints as %p', (marginIn, expected) => {
    expect(printTemplatePaper({ paper: { size: 'letter', marginIn } }).marginIn).toBe(expected);
  });

  it('clamps a margin to a quarter of the shorter side of the sheet', () => {
    expect(clampMarginIn(5, { w: 11, h: 8.5 })).toBe(8.5 / 4);
    expect(clampMarginIn(-0.1, { w: 11, h: 8.5 })).toBe(0);
    expect(clampMarginIn(1, { w: 11, h: 8.5 })).toBe(1);
  });

  it('checks the margin when a template is saved', () => {
    expect(() => assertPrintTemplateData({ paper: { size: 'a3', marginIn: 0.25 } })).not.toThrow();
    expect(() => assertPrintTemplateData({ paper: { size: 'a3', marginIn: -1 } })).toThrow(
      BadRequestException,
    );
    expect(() => assertPrintTemplateData({ paper: { size: 'a3', marginIn: 'wide' } })).toThrow(
      BadRequestException,
    );
  });
});

describe('PrintRenderService.render gives its slot back', () => {
  const before = process.env.CHROMIUM_WS_ENDPOINTS;
  afterEach(() => {
    if (before === undefined) delete process.env.CHROMIUM_WS_ENDPOINTS;
    else process.env.CHROMIUM_WS_ENDPOINTS = before;
  });

  function service(templateData: unknown) {
    const get = jest.fn(async (_user: unknown, id: string) => ({
      id,
      title: id,
      type: id === 'map-1' ? 'map' : 'print_template',
      data: id === 'map-1' ? {} : templateData,
    }));
    const create = jest.fn(async () => ({}));
    const prisma = {
      printRenderToken: { create, deleteMany: jest.fn(async () => ({ count: 0 })) },
    };
    const svc = new PrintRenderService(
      prisma as never,
      { get } as never,
      {} as never,
      { mint: () => 'ggprint.x.y' } as never,
    );
    const running = svc as unknown as { activeRenders: number };
    const slots = { total: () => running.activeRenders };
    return { svc, create, slots };
  }

  const user = { id: 'u1', orgId: 'o1' } as never;
  const args = { templateId: 'tpl-1', mapId: 'map-1' };

  it('refuses an unknown paper size before taking a slot, every time', async () => {
    const { svc, create, slots } = service({ paper: { size: 'poster' } });
    for (let i = 0; i < 6; i++) {
      await expect(runAsOrg('o1', () => svc.render(user, args))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(slots.total()).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('prints a template with an unknown orientation and a negative margin', async () => {
    process.env.CHROMIUM_WS_ENDPOINTS = 'ws://127.0.0.1:1';
    const { svc, create, slots } = service({
      paper: { size: 'letter', orientation: 'sideways', marginIn: -3 },
    });
    const err = await runAsOrg('o1', () => svc.render(user, args)).catch((e: unknown) => e);
    // Not refused: it went on to the browser, which this test has not.
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect(create).toHaveBeenCalled();
    expect(slots.total()).toBe(0);
  });

  it('gives the slot back when the browser cannot be reached', async () => {
    process.env.CHROMIUM_WS_ENDPOINTS = 'ws://127.0.0.1:1';
    const { svc, slots } = service({ paper: { size: 'letter' } });
    for (let i = 0; i < 6; i++) {
      const err = await runAsOrg('o1', () => svc.render(user, args)).catch((e: unknown) => e);
      // Not "busy": the earlier failures left no slot behind.
      expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(slots.total()).toBe(0);
  });
});

/**
 * A replica runs at most four renders at once and turns the rest away,
 * with the same limit and answer whichever organization asks.
 */
describe.each(['single', 'multi'] as const)(
  'PrintRenderService render limit, %s tenancy',
  (mode) => {
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

    function service(): { svc: PrintRenderService; running: { activeRenders: number } } {
      const get = jest.fn(async (_user: unknown, id: string) => ({
        id,
        title: id,
        type: id === 'map-1' ? 'map' : 'print_template',
        data: {},
      }));
      const prisma = {
        printRenderToken: {
          create: jest.fn(async () => ({})),
          deleteMany: jest.fn(async () => ({ count: 0 })),
        },
      };
      const svc = new PrintRenderService(
        prisma as never,
        { get } as never,
        {} as never,
        { mint: () => 'ggprint.x.y' } as never,
      );
      return { svc, running: svc as unknown as { activeRenders: number } };
    }

    const user = { id: 'u1', orgId: 'org-b' } as never;
    const args = { templateId: 'tpl-1', mapId: 'map-1' };

    it('turns a render away when four are running', async () => {
      const { svc, running } = service();
      running.activeRenders = 4;
      const err = await runAsOrg('org-b', () => svc.render(user, args)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as Error).message).toBe('The print service is busy. Try again in a minute.');
      expect(running.activeRenders).toBe(4);
    });

    it('takes the fourth slot and gives it back when the render fails', async () => {
      const { svc, running } = service();
      running.activeRenders = 3;
      const err = await runAsOrg('org-b', () => svc.render(user, args)).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(ServiceUnavailableException);
      expect(running.activeRenders).toBe(3);
    });
  },
);
