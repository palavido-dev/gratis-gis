// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  acceptRequestId,
  callerIsAdmin,
  mintRequestId,
  portalErrorBody,
  requestIdMiddleware,
  requestIdOf,
  sanitizePublicDetail,
} from './public-error.js';
import { OgcProblemJsonFilter } from '../public/ogc/problem-json.filter.js';

describe('sanitizePublicDetail', () => {
  it('keeps a sentence the server wrote for a person', () => {
    expect(
      sanitizePublicDetail(
        'Creating items requires the contributor or admin role.',
      ),
    ).toBe('Creating items requires the contributor or admin role.');
  });

  it('redacts secrets and drops a stack for a non-admin', () => {
    const text = [
      'connect failed password=hunter2',
      '    at ItemService.create (items.service.ts:1296:7)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(sanitizePublicDetail(text, false)).toBeNull();
    expect(sanitizePublicDetail(text, true)).toBe(
      'connect failed password=[redacted]',
    );
  });

  it('redacts bearer tokens, database URLs, and access keys', () => {
    const text =
      'upstream Bearer abc.def-ghi postgres://gis:s3cret@db:5432/gis AKIAIOSFODNN7EXAMPLE';
    expect(sanitizePublicDetail(text)).toBe(
      'upstream Bearer [redacted] [redacted] [redacted]',
    );
  });

  it('drops an HTML error page', () => {
    expect(sanitizePublicDetail('<html><body>Bad Gateway</body></html>')).toBeNull();
  });
});

describe('portalErrorBody', () => {
  it('keeps a validation message and adds the request id', () => {
    const { status, body } = portalErrorBody(
      new BadRequestException(['Name is required.']),
      { requestId: 'abc12345abcd', admin: false },
    );
    expect(status).toBe(400);
    expect(body.message).toEqual(['Name is required.']);
    expect(body.requestId).toBe('abc12345abcd');
    expect(body.stack).toBeUndefined();
  });

  it('hides an unexpected error from a non-admin and gives an admin one line', () => {
    const err = new Error('relation "item" does not exist');
    err.stack = `${err.message}\n    at PrismaClient.items.service.ts:1:1`;
    const hidden = portalErrorBody(err, {
      requestId: 'abc12345abcd',
      admin: false,
    });
    expect(hidden.status).toBe(500);
    expect(hidden.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'abc12345abcd',
    });

    const shown = portalErrorBody(err, {
      requestId: 'abc12345abcd',
      admin: true,
    });
    expect(shown.body.detail).toBe('relation "item" does not exist');
    expect(JSON.stringify(shown.body)).not.toContain('PrismaClient');
  });

  it('does not treat a written 500 sentence as an internal leak', () => {
    const { body } = portalErrorBody(
      new HttpException('Could not load sign-in settings.', 500),
      { requestId: 'abc12345abcd', admin: false },
    );
    expect(body.message).toBe('Could not load sign-in settings.');
    expect(body.detail).toBeUndefined();
  });
});

describe('request ids', () => {
  it('rejects ids that could break a log line', () => {
    expect(acceptRequestId('abc12345')).toBe('abc12345');
    expect(acceptRequestId('../etc/passwd')).toBeNull();
    expect(acceptRequestId('has space!')).toBeNull();
    expect(acceptRequestId('short')).toBeNull();
  });

  it('echoes a safe incoming id and replaces a bad one', () => {
    const headers: Record<string, string> = {};
    const req = {
      header: (name: string) =>
        name === 'x-request-id' ? 'good-id-1' : undefined,
    } as Request;
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;
    requestIdMiddleware(req, res, (() => undefined) as never);
    expect(headers['x-request-id']).toBe('good-id-1');
    expect(requestIdOf(req)).toBe('good-id-1');

    const bad = { header: () => '<script>' } as unknown as Request;
    requestIdMiddleware(bad, res, (() => undefined) as never);
    expect(acceptRequestId(headers['x-request-id'])).toBe(headers['x-request-id']);
    expect(headers['x-request-id']).not.toBe('<script>');
  });

  it('mints a 16-character hex id', () => {
    expect(mintRequestId()).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('OgcProblemJsonFilter portal errors', () => {
  const filter = new OgcProblemJsonFilter();

  function invoke(
    exception: unknown,
    user: { orgRole: string } | undefined,
  ): { status: number; body: unknown } {
    const captured: { status: number; body: unknown } = { status: 0, body: null };
    const req = {
      method: 'POST',
      originalUrl: '/api/items?token=secret',
      header: () => undefined,
      requestId: 'abc12345abcd',
      user,
    };
    const res = {
      headersSent: false,
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
      end() {
        return this;
      },
    };
    filter.catch(
      exception,
      {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
      } as unknown as ArgumentsHost,
    );
    return captured;
  }

  it('answers a refused create with JSON, not an HTML page', () => {
    const out = invoke(
      new BadRequestException('Creating items requires the contributor or admin role.'),
      { orgRole: 'contributor' },
    );
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      message: 'Creating items requires the contributor or admin role.',
      requestId: 'abc12345abcd',
    });
    expect(callerIsAdmin({ user: { orgRole: 'contributor' } } as Request)).toBe(
      false,
    );
  });

  it('keeps OGC routes on problem+json', () => {
    const captured: { type?: string; body?: unknown } = {};
    const req = {
      method: 'GET',
      originalUrl: '/api/public/ogc/collections/missing',
      url: '/api/public/ogc/collections/missing',
    };
    const res = {
      headersSent: false,
      status() {
        return this;
      },
      type(value: string) {
        captured.type = value;
        return this;
      },
      send(body: unknown) {
        captured.body = body;
        return this;
      },
    };
    filter.catch(new BadRequestException('bbox is invalid'), {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ArgumentsHost);
    expect(captured.type).toBe('application/problem+json');
    expect(captured.body).toMatchObject({ status: 400 });
  });
});
