// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {
  resolvePaperInches,
  type BasemapData,
  type MapData,
  type PrintPaperSpec,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

export interface RenderJobBundle {
  userId: string;
  userDisplayName: string;
  templateId: string;
  mapId: string;
  parameterValues: Record<string, string>;
  template: { id: string; title: string; type: string; data: unknown };
  map: { id: string; title: string; type: string; data: unknown };
  /**
   * #159 Phase 2.4: the resolved basemap blob for `map.data.basemap`,
   * fetched server-side under the originating user's permissions
   * via the items service. Null when the bound map has no basemap
   * set, or when the basemap is no longer visible to the user. The
   * snapshot renderer falls back to a vanilla OSM raster in those
   * cases so the print still produces a sensible page.
   */
  basemap: BasemapData | null;
}

/**
 * #159 Phase 2 server-side render path.
 *
 * Connects to one of the configured browserless sidecars
 * (load-balanced random pick), navigates to the internal
 * print-preview route on portal-web, renders the page at the
 * template's paper size, returns the PDF bytes.
 *
 * Authentication for the preview route: portal-api mints a
 * single-use token, stores it in-memory with a 60-second TTL,
 * and hands the chromium sidecar a URL with `?renderToken=...`.
 * The preview route on portal-web validates the token against
 * a portal-api callback before rendering, so the public can't
 * just hit the preview URL and exfiltrate map data they can't
 * otherwise read.
 */
const TOKEN_TTL_MS = 60_000;

@Injectable()
export class PrintRenderService {
  private readonly log = new Logger(PrintRenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
  ) {}

  /**
   * Validate a render token against the server's in-memory map.
   * Used by the preview route's "is this caller legit?" callback.
   * Tokens are single-use: a successful validation consumes the
   * entry.
   */
  async consumeToken(
    token: string,
  ): Promise<{ userId: string; templateId: string; mapId: string } | null> {
    // DELETE is the atomic single-use claim: exactly one caller, on
    // either replica, can remove a given row. A row that is not found
    // (unknown or already consumed) throws P2025, which we treat as a
    // null result.
    let row;
    try {
      row = await this.prisma.printRenderToken.delete({ where: { token } });
    } catch {
      return null;
    }
    if (row.expiresAt.getTime() < Date.now()) return null;
    return {
      userId: row.userId,
      templateId: row.templateId,
      mapId: row.mapId,
    };
  }

  /**
   * #159 Phase 2.2: single-shot load that the print-preview
   * route calls instead of consume + 2 item fetches. Validates
   * the token, resolves the user record, fetches the template +
   * map items with the user's permissions, and returns the
   * complete render bundle. Consuming + loading in one call
   * keeps the token surface area minimal (one network round
   * trip from chromium-network -> portal-api).
   */
  async loadJobByToken(token: string): Promise<RenderJobBundle | null> {
    const claims = await this.consumeToken(token);
    if (!claims) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: claims.userId },
    });
    if (!user) return null;
    // Build a minimal AuthUser-like shape for the items service.
    // We don't have access to the full Keycloak claims here, but
    // ItemsService.get only consumes id / orgId / orgRole / shares
    // for permission checks, all of which we have on the user row.
    const authUser = {
      id: user.id,
      orgId: user.orgId,
      orgSlug: user.orgId,
      username: user.username,
      email: user.email ?? '',
      orgRole: user.orgRole,
      groupIds: await this.loadGroupIds(user.id),
      capabilities: new Set<never>(),
    } as unknown as AuthUser;
    const [template, map] = await Promise.all([
      this.items.get(authUser, claims.templateId),
      this.items.get(authUser, claims.mapId),
    ]);
    // Phase 2.4: resolve the bound map's basemap so the snapshot
    // renders against the right tiles. We skip the fetch when the
    // map has no basemap set (legacy / unconfigured) and swallow
    // a permission failure as null so a basemap the user can't
    // read drops back to the OSM raster fallback rather than
    // failing the whole render.
    let basemap: BasemapData | null = null;
    const basemapId = (map.data as MapData | null)?.basemap ?? '';
    if (basemapId) {
      try {
        const basemapItem = await this.items.get(authUser, basemapId);
        if (basemapItem.type === 'basemap') {
          basemap = (basemapItem.data ?? null) as BasemapData | null;
        }
      } catch {
        basemap = null;
      }
    }
    const userDisplayName =
      (user.fullName && user.fullName.trim().length > 0
        ? user.fullName
        : null) ??
      user.username ??
      'Reviewer';
    return {
      userId: user.id,
      userDisplayName: userDisplayName.slice(0, 200),
      templateId: claims.templateId,
      mapId: claims.mapId,
      parameterValues: {},
      template: {
        id: template.id,
        title: template.title,
        type: template.type,
        data: template.data,
      },
      map: {
        id: map.id,
        title: map.title,
        type: map.type,
        data: map.data,
      },
      basemap,
    };
  }

  private async loadGroupIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.groupMember.findMany({
      where: { userId },
      select: { groupId: true },
    });
    return rows.map((r: { groupId: string }) => r.groupId);
  }

  async render(
    user: AuthUser,
    args: {
      templateId: string;
      mapId: string;
      parameterValues?: Record<string, string>;
    },
  ): Promise<Buffer> {
    // 1. Load + permission-check both items via the items service.
    const template = await this.items.get(user, args.templateId);
    if (template.type !== 'print_template') {
      throw new BadRequestException(
        `Item ${args.templateId} is not a print_template`,
      );
    }
    const map = await this.items.get(user, args.mapId);
    if (map.type !== 'map') {
      throw new BadRequestException(`Item ${args.mapId} is not a map`);
    }
    const paper = (
      (template.data as { paper?: PrintPaperSpec } | null)?.paper ?? {
        size: 'letter',
        orientation: 'portrait',
        marginIn: 0.25,
      }
    ) as PrintPaperSpec;

    // 2. Mint a render token in the shared store (PrintRenderToken).
    // In-memory would fail across the 2-replica prod topology: the
    // sidecar's consume callback lands on either replica.
    const token = randomBytes(24).toString('hex');
    await this.prisma.printRenderToken.create({
      data: {
        token,
        userId: user.id,
        templateId: args.templateId,
        mapId: args.mapId,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });
    // Opportunistically sweep expired tokens so an unconsumed mint
    // cannot grow the table unbounded (fire-and-forget).
    this.prisma.printRenderToken
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => {
        /* best effort */
      });

    // 3. Pick a chromium endpoint at random for load balancing.
    const endpoints = (process.env.CHROMIUM_WS_ENDPOINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (endpoints.length === 0) {
      throw new ServiceUnavailableException(
        'No chromium endpoints configured (CHROMIUM_WS_ENDPOINTS)',
      );
    }
    const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)]!;
    const previewBase = process.env.PRINT_PREVIEW_BASE_URL ?? 'http://portal-web:3000';

    // 4. Build the preview URL with the token + parameter values
    //    encoded as a single ?p=<base64-json> blob so the URL
    //    stays short even for templates with many parameters.
    const paramsBlob = Buffer.from(
      JSON.stringify(args.parameterValues ?? {}),
    ).toString('base64url');
    const previewUrl =
      `${previewBase}/print-preview/${encodeURIComponent(args.templateId)}` +
      `?map=${encodeURIComponent(args.mapId)}` +
      `&renderToken=${encodeURIComponent(token)}` +
      `&p=${paramsBlob}`;

    // 5. Connect, navigate, page.pdf, return bytes.
    const inches = resolvePaperInches(paper);
    const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    try {
      const page = await browser.newPage();
      try {
        await page.setViewport({
          width: Math.round(inches.w * 96),
          height: Math.round(inches.h * 96),
        });
        await page.goto(previewUrl, {
          waitUntil: 'networkidle0',
          timeout: 30_000,
        });
        // #159 Phase 2.2: the inline MapLibre snapshot signals
        // readiness by setting body[data-map-ready="true"] once
        // tiles + layers settle. Wait up to 15s so the captured
        // PDF contains the rendered map rather than a blank
        // canvas. Templates without a Map element resolve this
        // check from the MapSnapshot's 12s hard-ceiling fallback,
        // which is harmless when no map is rendered.
        try {
          await page.waitForSelector('body[data-map-ready="true"]', {
            timeout: 15_000,
          });
        } catch {
          // Map didn't signal in time; capture whatever's there.
          this.log.warn(
            `Map-ready signal timed out for template ${args.templateId}; capturing anyway`,
          );
        }
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: false,
          width: `${inches.w}in`,
          height: `${inches.h}in`,
          margin: {
            top: `${paper.marginIn}in`,
            right: `${paper.marginIn}in`,
            bottom: `${paper.marginIn}in`,
            left: `${paper.marginIn}in`,
          },
        });
        // puppeteer.page.pdf returns Uint8Array on recent versions;
        // wrap as a Buffer so the controller can stream it.
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.disconnect();
    }
  }
}
