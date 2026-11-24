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
  if (configured) return configured.replace(/(?<!\/)\/+$/, '');

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

/**
 * `href` with `org=<slug>` added, for a link to a list or feed of one
 * organization. No slug, or a link that already names an org, comes
 * back unchanged.
 */
export function withOrgParam(href: string, slug: string | undefined): string {
  if (!slug) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.searchParams.has('org')) return href;
  url.searchParams.set('org', slug);
  return url.toString();
}

/**
 * Add `org=<slug>` to every `href` in a link document whose path is
 * one of `listPaths` (compared on the end of the path, so a base URL
 * with a path prefix still matches). Links to single items are left
 * alone: they need no organization and some of them refuse unknown
 * query parameters. Returns the same document, changed in place.
 *
 * Every list and feed of the public catalogs runs its answer through
 * this, so a client that follows the links (QGIS, MetaSearch, a STAC
 * browser) stays inside the organization it started in.
 */
export function withOrgLinks<T>(doc: T, slug: string | undefined, listPaths: readonly string[]): T {
  if (!slug) return doc;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const value = rec[key];
      if (key === 'href' && typeof value === 'string') {
        if (isListHref(value, listPaths)) rec.href = withOrgParam(value, slug);
      } else {
        visit(value);
      }
    }
  };
  visit(doc);
  return doc;
}

function isListHref(href: string, listPaths: readonly string[]): boolean {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return false;
  }
  return listPaths.some((p) => path.endsWith(p));
}

/** Paths of the public OGC API lists and catalog documents. */
export const OGC_LIST_PATHS = [
  '/api/public/ogc',
  '/api/public/ogc/',
  '/api/public/ogc/collections',
  '/api/public/ogc/collections/catalog',
  '/api/public/ogc/collections/catalog/items',
  '/api/public/ogc/records',
  '/api/public/ogc/styles',
] as const;
