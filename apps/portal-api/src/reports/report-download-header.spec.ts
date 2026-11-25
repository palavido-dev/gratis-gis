// SPDX-License-Identifier: AGPL-3.0-or-later
import { validateHeaderValue } from 'node:http';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { ItemsService } from '../items/items.service.js';
import { WhatsHereController } from '../whats-here/whats-here.controller.js';
import type { WhatsHereReportService } from '../whats-here/whats-here-report.service.js';
import { ReportsController } from './reports.controller.js';
import type { ReportsService } from './reports.service.js';

/**
 * A report named with a character above U+00FF (Cyrillic or CJK)
 * used to answer 500: the controllers put the name straight into
 * Content-Disposition and Node throws ERR_INVALID_CHAR on such a header.
 */

const NAMES = ['Отчёт 報告', 'Карта участка', 'Plain report'];

// Checks each header the way Node's own setHeader does.
function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      validateHeaderValue(name, value);
      headers[name.toLowerCase()] = value;
    },
    end: jest.fn(),
  };
  return { res: res as unknown as Response, headers, end: res.end };
}

function expectRealName(header: string | undefined, name: string) {
  const star = /filename\*=UTF-8''(.+)$/.exec(header ?? '')?.[1];
  expect(star).toBeDefined();
  expect(decodeURIComponent(star!)).toBe(`${name}.pdf`);
}

const PDF = Buffer.from('%PDF-1.7');

describe('report download file names', () => {
  it.each(NAMES)('a report template named %s downloads', async (title) => {
    const items = {
      get: jest.fn().mockResolvedValue({
        type: 'report_template',
        title,
        data: { sources: [{ itemId: 'src', layerKey: 'layer' }], body: '' },
      }),
    } as unknown as ItemsService;
    const reports = {
      fill: jest.fn().mockResolvedValue({ features: [{ id: 'f1' }], issues: [] }),
      document: jest.fn().mockReturnValue('<html></html>'),
      pdf: jest.fn().mockResolvedValue(PDF),
    } as unknown as ReportsService;
    const { res, headers, end } = fakeResponse();

    await new ReportsController(reports, items).render(
      { id: 'u1' } as AuthUser,
      '00000000-0000-0000-0000-000000000001',
      { featureIds: ['00000000-0000-0000-0000-000000000002'] },
      res,
    );

    expect(end).toHaveBeenCalledWith(PDF);
    expectRealName(headers['content-disposition'], title);
  });

  it.each(NAMES)("a What's Here report named %s downloads", async (fileName) => {
    const service = {
      pdf: jest.fn().mockResolvedValue({ pdf: PDF, fileName }),
    } as unknown as WhatsHereReportService;
    const { res, headers, end } = fakeResponse();

    await new WhatsHereController(service).report({} as Request & { user?: AuthUser }, {}, res);

    expect(end).toHaveBeenCalledWith(PDF);
    expectRealName(headers['content-disposition'], fileName);
  });
});
