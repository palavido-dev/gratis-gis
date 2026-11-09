// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read-only client for the ArcGIS Online / Enterprise sharing
 * REST API. Walks a user's content (items + folders), fetches
 * per-item metadata, and returns the typed shapes from
 * ``ago-types.ts``. Other modules wire the results onto the
 * portal item-create path; this client never writes.
 *
 * Why this is its own service instead of a thin fetch wrapper:
 *
 *   - AGO's sharing API returns 200 OK with an ``error`` object
 *     on failure. The error envelope has to be detected per
 *     response, so the request path needs its own checker.
 *
 *   - Pagination is per-endpoint (``start`` / ``nextStart`` or
 *     ``num`` cursor). Walking a user's content with hundreds
 *     of items needs the pagination logic in one place.
 *
 *   - Token-handling is centralized. Every call carries
 *     ``?token=<token>`` (or skips it for anonymous reads of
 *     public content) and ``?f=json`` for JSON output. Doing
 *     that per call-site would invite drift.
 *
 *   - SSRF protection. AGO base URLs are user-provided. The
 *     ``safeFetch`` wrapper at the bottom validates the URL
 *     against the outbound-host allowlist, matching what the
 *     existing arcgis-auth path uses.
 *
 * Memory-only: nothing here writes to disk or DB. Caller owns
 * persistence.
 */
import { Injectable, Logger } from '@nestjs/common';

import { safeFetch } from '../common/net-guards.js';

import type {
  AgoErrorEnvelope,
  AgoItem,
  AgoPortalSelf,
  AgoUserContentResponse,
} from './ago-types.js';

/**
 * Thrown when the AGO server returns an error envelope or an
 * HTTP failure. Carries the AGO error code + message so the
 * caller can present a clean error to the operator and log
 * the rest for diagnostics.
 */
export class AgoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'AgoApiError';
  }
}

/**
 * Per-request handle to one AGO portal. Composes URLs from a
 * shared portal URL + token; safe to reuse across paginated
 * calls. NOT reusable across portals -- construct a new client
 * for a different portalUrl + token.
 */
export interface AgoClientConfig {
  /** Portal sharing root, e.g.
   *  ``https://www.arcgis.com/sharing/rest`` for AGO SaaS or
   *  ``https://gis.org.example/portal/sharing/rest`` for an
   *  enterprise instance. Trailing slash optional; the client
   *  normalizes. */
  portalUrl: string;
  /** Auth token. AGO calls accept ``?token=...`` query param;
   *  we use that form rather than the Authorization header for
   *  uniform proxy behaviour against older AGO versions. Empty
   *  string is acceptable when the caller is reading public
   *  content. */
  token: string;
  /** Optional request timeout in ms. Default 15s; long enough
   *  for slow AGO pages (catalogue listings can take several
   *  seconds on large orgs) but short enough that a stuck
   *  upstream doesn't hang the import job indefinitely. */
  timeoutMs?: number;
}

@Injectable()
export class AgoClient {
  private readonly log = new Logger(AgoClient.name);

  private readonly portalUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: AgoClientConfig) {
    // Manual trailing-slash strip: the regex form (`/\/+$/`) is
    // O(n) on a fully-slashes input but CodeQL js/polynomial-redos
    // still flags it because of the user-controlled source. A loop
    // is just as cheap and sidesteps the warning.
    let portal = config.portalUrl;
    while (portal.endsWith('/')) portal = portal.slice(0, -1);
    this.portalUrl = portal;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Fetch the portal-self document. Identifies the calling user
   * and confirms the token is valid. First call in any import
   * flow because everything downstream is scoped to the user.
   */
  async portalSelf(): Promise<AgoPortalSelf> {
    return this.fetchJson<AgoPortalSelf>('/portals/self', {});
  }

  /**
   * URLs of the servers federated with this portal. Used to decide
   * where the portal token may be sent. Best-effort: ArcGIS Online and
   * some Enterprise versions answer with an error or nothing, which
   * means "only the portal itself".
   */
  async portalServers(): Promise<string[]> {
    try {
      const body = await this.fetchJson<{
        servers?: Array<{ url?: unknown }>;
      }>('/portals/self/servers', {});
      return (body.servers ?? [])
        .map((s) => s.url)
        .filter((u): u is string => typeof u === 'string');
    } catch {
      return [];
    }
  }

  /**
   * List one page of a user's content at root (or in a specific
   * folder). AGO paginates with ``start`` + ``num`` and surfaces
   * ``nextStart`` (or -1 if no more); callers usually want
   * ``walkUserContent`` below instead of paging this directly.
   *
   * @param username  AGO username (case-sensitive on Enterprise)
   * @param folderId  Folder id; null/undefined for root
   * @param start     1-based start index (AGO convention)
   * @param num       Page size, max 100
   */
  async listUserContent(args: {
    username: string;
    folderId?: string | null;
    start?: number;
    num?: number;
  }): Promise<AgoUserContentResponse> {
    const start = args.start ?? 1;
    const num = Math.min(args.num ?? 100, 100);
    const path = args.folderId
      ? `/content/users/${encodeURIComponent(args.username)}/${encodeURIComponent(args.folderId)}`
      : `/content/users/${encodeURIComponent(args.username)}`;
    return this.fetchJson<AgoUserContentResponse>(path, {
      start: String(start),
      num: String(num),
    });
  }

  /**
   * Walk every item the user owns, across root + every folder.
   * Yields items in a deterministic order (folders sorted by
   * title, then by AGO's natural pagination order within each).
   *
   * Caller-supplied ``onPage`` is invoked per page so a large
   * walk can stream into a job-progress UI without buffering
   * the whole list in memory.
   */
  async walkUserContent(args: {
    username: string;
    onItem: (item: AgoItem, folder: { id: string | null; title: string }) => void | Promise<void>;
  }): Promise<{ total: number; folders: number }> {
    let total = 0;

    // Root listing first. The root page also tells us which
    // folders to walk, so we have to fetch it before recursing
    // (no separate "list folders" endpoint).
    const root = await this.listUserContent({ username: args.username });
    const rootFolder = { id: null as string | null, title: '(root)' };
    for (const item of root.items ?? []) {
      await args.onItem(item, rootFolder);
      total += 1;
    }
    // Continue paginating root if there are more pages.
    let nextStart = root.nextStart ?? -1;
    while (nextStart > 0) {
      const page = await this.listUserContent({
        username: args.username,
        start: nextStart,
      });
      for (const item of page.items ?? []) {
        await args.onItem(item, rootFolder);
        total += 1;
      }
      nextStart = page.nextStart ?? -1;
    }

    // Now each folder. Folders only appear in the root response
    // (AGO doesn't have nested folders), so we already have the
    // full list.
    const folders = (root.folders ?? []).slice().sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    for (const folder of folders) {
      const folderRef = { id: folder.id, title: folder.title };
      let start: number | undefined = 1;
      while (start && start > 0) {
        const page: AgoUserContentResponse = await this.listUserContent({
          username: args.username,
          folderId: folder.id,
          start,
        });
        for (const item of page.items ?? []) {
          await args.onItem(item, folderRef);
          total += 1;
        }
        const next = page.nextStart;
        start = typeof next === 'number' && next > 0 ? next : undefined;
      }
    }

    return { total, folders: folders.length };
  }

  /**
   * Fetch full metadata for a single item. Use this to pick up
   * fields that the listing doesn't include (e.g.
   * ``properties``, ``serviceItemId``, ``screenshots``).
   */
  async getItem(itemId: string): Promise<AgoItem & Record<string, unknown>> {
    return this.fetchJson<AgoItem & Record<string, unknown>>(
      `/content/items/${encodeURIComponent(itemId)}`,
      {},
    );
  }

  /**
   * Fetch the type-specific data envelope. For a Web Map this is
   * the WebMap JSON; for a Form, the survey JSON; etc. Returns
   * raw object so per-type importers can do their own
   * narrowing/validation downstream.
   */
  async getItemData<T = unknown>(itemId: string): Promise<T> {
    return this.fetchJson<T>(
      `/content/items/${encodeURIComponent(itemId)}/data`,
      {},
    );
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private async fetchJson<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      res = await safeFetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new AgoApiError(
          0,
          undefined,
          `AGO request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new AgoApiError(
        0,
        undefined,
        `AGO network error: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new AgoApiError(
        res.status,
        undefined,
        `AGO HTTP ${res.status} on ${path}`,
      );
    }
    const body = (await res.json()) as T & AgoErrorEnvelope;
    // AGO returns 200 OK with an error envelope on failure. Detect
    // and surface it as a typed exception.
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      (body as AgoErrorEnvelope).error
    ) {
      const e = (body as AgoErrorEnvelope).error!;
      throw new AgoApiError(
        res.status,
        e.code,
        e.message ?? 'AGO returned an error envelope',
        e.details,
      );
    }
    return body;
  }

  private buildUrl(path: string, extra: Record<string, string>): string {
    const safePath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(this.portalUrl + safePath);
    // f=json is the universal "give me JSON" flag for AGO.
    url.searchParams.set('f', 'json');
    if (this.token) {
      url.searchParams.set('token', this.token);
    }
    for (const [k, v] of Object.entries(extra)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }
}
