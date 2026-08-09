// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

/**
 * The absolute `scheme://host` to put in OGC link documents.
 *
 * Prefers PORTAL_BASE_URL, the deployment's own configured public URL,
 * and only falls back to the request's Host / X-Forwarded-Host for local
 * dev where the env var is unset. Those headers are client-controlled: a
 * forged `X-Forwarded-Host: evil.example` would otherwise appear in the
 * `self`/`next` links this returns, redirecting OGC clients (QGIS
 * following the links) and poisoning any cache in front. The env var is
 * set on portal-api in prod, so the header path never runs there.
 */
export function absoluteBase(req: Request): string {
  const configured = process.env.PORTAL_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    req.protocol ??
    'http';
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    req.headers.host ??
    'localhost';
  return `${proto}://${host}`;
}
