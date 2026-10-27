// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ArcgisServiceData } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { assertSafeOutboundUrl, safeFetch } from '../common/net-guards.js';
import {
  AgoHostedFsImportService,
  ARCGIS_COPY_FEATURE_HARD_CAP,
  type HostedFsImportResult,
} from '../import-ago/hosted-fs.js';
import { CredentialService } from './credential.service.js';
import { ItemsService } from './items.service.js';

/**
 * Copy selected ArcGIS FeatureServer layers into a new portal
 * data_layer (R5-arcgis-pull-to-local). Reuses hosted-fs pagination
 * (`outSR=4326`, page 2000) with a hard feature cap. The source
 * arcgis_service item stays a live pointer.
 */
@Injectable()
export class ArcgisCopyToDataLayerService {
  private readonly log = new Logger(ArcgisCopyToDataLayerService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly credentials: CredentialService,
    private readonly hostedFs: AgoHostedFsImportService,
  ) {}

  async copy(args: {
    user: AuthUser;
    itemId: string;
    title?: string;
    layerIds?: number[];
    maxFeatures?: number;
  }): Promise<HostedFsImportResult> {
    if (!args.user) {
      throw new BadRequestException('Authentication required.');
    }
    await this.items.assertCanEdit(args.user, args.itemId);
    const item = await this.items.get(args.user, args.itemId);
    if (item.type !== 'arcgis_service') {
      throw new BadRequestException(
        'Copy to data layer only works on ArcGIS service items.',
      );
    }
    const data = (item.data ?? {}) as Partial<ArcgisServiceData>;
    const rawUrl = typeof data.url === 'string' ? data.url.trim() : '';
    if (!rawUrl) {
      throw new BadRequestException(
        'This ArcGIS service item has no URL. Probe and Save first.',
      );
    }

    const serviceUrl = await this.resolveFeatureServerUrl(
      rawUrl,
      data.serviceType,
    );

    const selected =
      args.layerIds && args.layerIds.length > 0
        ? args.layerIds
        : (data.selectedLayerIds ?? []).map((id) => Number(id)).filter(Number.isFinite);
    if (selected.length === 0) {
      throw new BadRequestException(
        'Select at least one layer on the ArcGIS service item before copying.',
      );
    }

    let token: string | undefined;
    if (data.requiresAuth) {
      try {
        const cred = await this.credentials.getCredentialForProxy(args.itemId);
        if (cred.kind === 'bearer' || cred.kind === 'arcgis_token') {
          token = cred.token;
        } else {
          // FeatureServer query accepts token= more reliably than basic
          // auth headers through our importer; surface an honest refusal.
          throw new BadRequestException(
            'Copy to data layer currently needs a token credential (not basic auth). Store a token on this item, or use a public FeatureServer.',
          );
        }
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        throw new BadRequestException(
          'This service requires auth, but no usable credential is stored on the item.',
        );
      }
    }

    const title = (
      typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : `${item.title} (copy)`
    ).slice(0, 200);

    const access =
      item.access === 'public' || item.access === 'org' ? item.access : 'private';

    this.log.log(
      `Copying ${selected.length} layer(s) from ${serviceUrl} → data_layer for item ${args.itemId}`,
    );

    try {
      return await this.hostedFs.runSelected({
        user: args.user,
        serviceUrl,
        title,
        access,
        layerIds: selected,
        maxFeatures: args.maxFeatures ?? ARCGIS_COPY_FEATURE_HARD_CAP,
        copyAttachments: false,
        ...(token !== undefined ? { token } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(msg);
    }
  }

  /**
   * FeatureServer URLs pass through. MapServer URLs only succeed when
   * a sibling FeatureServer responds to `?f=json` with layers
   * (refuse MapServer-only endpoints — they are not queryable the
   * same way).
   */
  async resolveFeatureServerUrl(
    rawUrl: string,
    serviceType: ArcgisServiceData['serviceType'] | undefined,
  ): Promise<string> {
    const clean = rawUrl.replace(/\/+$/, '');
    if (/\/FeatureServer$/i.test(clean) || serviceType === 'FeatureServer') {
      if (/\/FeatureServer$/i.test(clean)) return clean;
      // serviceType says FeatureServer but URL may still be a root;
      // keep as-is and let hosted-fs probe fail honestly.
      return clean;
    }
    if (/\/MapServer$/i.test(clean) || serviceType === 'MapServer') {
      const twin = clean.replace(/\/MapServer$/i, '/FeatureServer');
      if (twin === clean) {
        throw new BadRequestException(
          'MapServer URLs cannot be copied. Use a FeatureServer URL, or a MapServer that has a FeatureServer twin at the same path.',
        );
      }
      await assertSafeOutboundUrl(`${twin}?f=json`);
      const res = await safeFetch(`${twin}?f=json`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new BadRequestException(
          `No queryable FeatureServer twin at ${twin} (HTTP ${res.status}). MapServer-only endpoints cannot be copied into a data layer.`,
        );
      }
      const body = (await res.json().catch(() => null)) as {
        layers?: unknown[];
        error?: { message?: string };
      } | null;
      if (body?.error?.message) {
        throw new BadRequestException(
          `FeatureServer twin refused the probe: ${body.error.message}`,
        );
      }
      if (!Array.isArray(body?.layers) || body.layers.length === 0) {
        throw new BadRequestException(
          `FeatureServer twin at ${twin} has no layers to copy.`,
        );
      }
      return twin;
    }
    throw new BadRequestException(
      'Copy to data layer needs a FeatureServer URL (or a MapServer with a FeatureServer twin).',
    );
  }
}
