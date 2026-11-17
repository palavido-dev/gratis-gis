// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Error bodies a browser is allowed to read.
 *
 * portal-api's useful failures are HttpExceptions whose `message` was
 * written as a sentence ("Creating items requires the contributor or
 * admin role."). Those stay. Anything else — a Prisma stack, a
 * connection string, a query that echoed a secret — is logged with a
 * request id and is not returned. Admins get one redacted line from
 * an unexpected error so they can match it to that log; everyone else
 * gets the status and the request id.
 */
import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Tokens only. A request id is logged and shown in the UI, so a
 *  value with spaces, quotes, or slashes is rejected and replaced. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const GENERIC_MESSAGE = /^(internal server error|request failed)\.?$/i;

export function acceptRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function mintRequestId(): string {
  return randomBytes(8).toString('hex');
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = acceptRequestId(req.header(REQUEST_ID_HEADER)) ?? mintRequestId();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function requestIdOf(req: Request): string {
  const stamped = (req as Request & { requestId?: unknown }).requestId;
  return (
    acceptRequestId(stamped) ??
    acceptRequestId(req.header?.(REQUEST_ID_HEADER)) ??
    mintRequestId()
  );
}

export function callerIsAdmin(req: Request): boolean {
  const user = (req as Request & { user?: { orgRole?: unknown } }).user;
  return user?.orgRole === 'admin';
}

/**
 * A sentence safe to put on screen. Secrets are replaced in place.
 * A stack trace is dropped for everyone except an admin, who gets
 * the first line only (the exception message, not the frames).
 * Returns null when nothing safe is left.
 */
export function sanitizePublicDetail(
  text: string,
  admin = false,
): string | null {
  const redacted = redactSecrets(text).replace(/\0/g, '').trim();
  if (!redacted || redacted.startsWith('<') || /<html/i.test(redacted)) {
    return null;
  }
  if (!looksLikeStack(redacted)) return clip(redacted);
  if (!admin) return null;
  const first = redacted
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !looksLikeFrame(line));
  if (!first) return null;
  const safe = redactSecrets(first).trim();
  return safe ? clip(safe) : null;
}

export function portalErrorBody(
  exception: unknown,
  opts: { requestId: string; admin: boolean },
): { status: number; body: Record<string, unknown> } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = httpBody(exception.getResponse(), status);
    delete body.stack;
    delete body.trace;
    const cleaned = sanitizeMessageField(body.message, opts.admin);
    body.message =
      cleaned ??
      (status >= 500 ? 'Internal server error' : 'Request failed');
    body.requestId = opts.requestId;
    if (typeof body.statusCode !== 'number') body.statusCode = status;
    return { status, body };
  }

  const raw = exception instanceof Error ? exception.message : String(exception);
  const detail = opts.admin ? sanitizePublicDetail(raw, true) : null;
  return {
    status: 500,
    body: {
      statusCode: 500,
      message: 'Internal server error',
      requestId: opts.requestId,
      ...(detail && !GENERIC_MESSAGE.test(detail) ? { detail } : {}),
    },
  };
}

function httpBody(raw: unknown, status: number): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {
    statusCode: status,
    message: typeof raw === 'string' && raw ? raw : 'Request failed',
  };
}

function sanitizeMessageField(
  message: unknown,
  admin: boolean,
): string | string[] | null {
  if (typeof message === 'string') return sanitizePublicDetail(message, admin);
  if (!Array.isArray(message)) return null;
  const lines = message
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => sanitizePublicDetail(entry, admin))
    .filter((entry): entry is string => !!entry);
  return lines.length > 0 ? lines : null;
}

function redactSecrets(text: string): string {
  // Fresh expressions each call. A shared /g pattern keeps lastIndex
  // and silently skips the next secret.
  return text
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)(\S+)/gi,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s'")]+/gi,
      '[redacted]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]');
}

function looksLikeStack(text: string): boolean {
  return text.split('\n').some((line) => looksLikeFrame(line));
}

function looksLikeFrame(line: string): boolean {
  return (
    /^\s*at\s+\S/.test(line) ||
    /\([^()\n]*\.(?:js|ts|mjs|cjs):\d+:\d+\)/.test(line)
  );
}

function clip(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}
