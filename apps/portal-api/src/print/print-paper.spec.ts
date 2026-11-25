// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { runAsOrg } from '../common/tenant-context.js';
import { assertPrintTemplateData, printTemplatePaper } from './print-paper.js';
import { PrintRenderService } from './print-render.service.js';

describe('print template paper', () => {
  it('reads a known size and orientation', () => {
    expect(printTemplatePaper({ paper: { size: 'a4', orientation: 'landscape' } })).toEqual({
      size: 'a4',
      orientation: 'landscape',
      inches: { w: 11.69, h: 8.27 },
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
    ['an unknown orientation', { paper: { size: 'letter', orientation: 'sideways' } }],
    ['paper that is not an object', { paper: 'letter' }],
  ])('refuses %s with a 400', (_label, data) => {
    expect(() => printTemplatePaper(data)).toThrow(BadRequestException);
    expect(() => assertPrintTemplateData(data)).toThrow(BadRequestException);
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
    const slots = (svc as unknown as { rendersByOrg: { total(): number } }).rendersByOrg;
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
