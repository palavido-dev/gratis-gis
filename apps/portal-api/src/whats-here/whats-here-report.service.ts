// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, NotFoundException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';
import type { ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AreaOfInterestService } from '../area-of-interest/area-of-interest.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import type { AggregateOp } from '../engine/data-layer.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicTierGeoLimit, PUBLIC_TIER_SELECT } from '../public/public-geo-limit.js';
import { ReportsService } from '../reports/reports.service.js';
import { renderWhatsHereReport, type ReportLayer, type ReportRow } from './report-html.js';
import { parseReportRequest, type ReportLayerRequest } from './report-request.js';

/** Breakdown rows per layer, the same cap the panel shows. */
const BREAKDOWN_LIMIT = 50;
/** Layers read at once while building one report. */
const REPORT_CONCURRENCY = 4;

interface V3Layer {
  id: string;
  geometryType?: string | null;
  editingPolicy?: 'all-rows' | 'own-rows-only';
  fields?: FeatureField[];
}

/** What one layer may be read as, for the signed-in or anonymous caller. */
interface LayerAccess {
  layer: V3Layer;
  geoLimit: unknown;
  ownRowsOnly?: { userId: string };
  /** Reads a pick list the way this caller may. */
  readPickList: (id: string) => Promise<unknown>;
}

/**
 * The What's Here PDF (#796).
 *
 * The client says what to report on; this reads every number again
 * under the caller's own access, exactly as the panel's aggregate
 * reads did (share geo limits and own-rows scope for a signed-in
 * caller, the public tier clip for an anonymous one on a public app).
 * A layer the caller cannot read is named as unavailable rather than
 * dropped, so a report never looks complete when it is not.
 */
@Injectable()
export class WhatsHereReportService {
  constructor(
    private readonly areas: AreaOfInterestService,
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly v3: DataLayerFeaturesService,
    private readonly reports: ReportsService,
  ) {}

  async pdf(user: AuthUser | null, body: unknown): Promise<{ pdf: Buffer; fileName: string }> {
    const req = parseReportRequest(body);
    const areaId = (await this.areas.touch(req.areaId))!;
    const row = await this.prisma.areaOfInterest.findUnique({
      where: { id: areaId },
      select: { squareMeters: true },
    });
    if (!row) throw new NotFoundException('This area has expired. Pick it again.');

    // A few at a time, in order: a screening map can have dozens of
    // layers, and the aggregate lane is shared with every dashboard on
    // the server, so not all of them at once either.
    const layers: ReportLayer[] = new Array(req.layers.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < req.layers.length) {
        const i = next++;
        layers[i] = await this.screen(user, req.layers[i]!, areaId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REPORT_CONCURRENCY, req.layers.length) }, worker));

    const title = req.title?.trim() || req.labels.title;
    const html = renderWhatsHereReport({
      title,
      generatedAt: new Date(),
      locale: req.locale,
      timeZone: req.timeZone,
      labels: req.labels,
      areaSquareMeters: row.squareMeters,
      distanceMeters: req.distanceMeters,
      picked: req.picked,
      areaUnit: req.areaUnit,
      lengthUnit: req.lengthUnit,
      layers,
      ...(req.place ? { place: req.place } : {}),
      ...(req.mapImage ? { mapImage: req.mapImage } : {}),
    });
    const pdf = await this.reports.pdf(
      html,
      { size: req.paper, orientation: 'portrait' },
      { anonymous: user === null },
    );
    return { pdf, fileName: title };
  }

  private async screen(
    user: AuthUser | null,
    req: ReportLayerRequest,
    areaOfInterestId: string,
  ): Promise<ReportLayer> {
    let access: LayerAccess;
    try {
      access = user ? await this.signedIn(user, req) : await this.anonymous(req);
    } catch {
      // Not found, not shared, or not a data layer: all read the same
      // to the caller, and none of them stops the rest of the report.
      return { title: req.title, geometry: null };
    }
    const gt = access.layer.geometryType;
    const geometry = gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
    // A table has no shape to cut by the area.
    if (!geometry) return { title: req.title, geometry: null };
    const op: AggregateOp | null =
      geometry === 'polygon' ? 'area' : geometry === 'line' ? 'length' : null;
    const aggs: Array<{ op: AggregateOp; field?: string; as: string }> = [
      { op: 'count', as: 'count' },
    ];
    if (op) aggs.push({ op, as: 'measure' });
    // Only plain number fields still on the layer: a field may have
    // been removed or retyped since the panel was opened.
    const sumFields = (req.sumFields ?? [])
      .map((name) => access.layer.fields?.find((f) => f.name === name))
      .filter(
        (f): f is FeatureField =>
          !!f &&
          f.type === 'number' &&
          f.domain?.type !== 'coded-value' &&
          f.domain?.type !== 'coded-value-ref',
      );
    sumFields.forEach((f, i) => aggs.push({ op: 'sum', field: f.name, as: `sum_${i}` }));
    const base = {
      aggs,
      areaOfInterestId,
      ...(access.geoLimit ? { geoLimit: access.geoLimit } : {}),
      ...(access.ownRowsOnly ? { ownRowsOnly: access.ownRowsOnly } : {}),
    };
    const toRow = (values: Record<string, number | null>, value: string | null): ReportRow => ({
      value,
      count: values.count ?? 0,
      measure: op ? (values.measure ?? 0) : null,
      ...(sumFields.length > 0 ? { sums: sumFields.map((_, i) => values[`sum_${i}`] ?? null) } : {}),
    });

    const whole = await this.v3.aggregateFeatures(req.itemId, req.layerKey, base);
    const out: ReportLayer = {
      title: req.title,
      geometry,
      total: toRow(whole.groups[0]?.values ?? {}, null),
      ...(sumFields.length > 0
        ? { sumLabels: sumFields.map((f) => f.label?.trim() || f.name) }
        : {}),
    };

    const field = req.breakdownField
      ? access.layer.fields?.find((f) => f.name === req.breakdownField)
      : undefined;
    // A field that is not on the layer is left out rather than refused:
    // the layer may have changed since the panel was opened.
    if (field && out.total!.count > 0) {
      const grouped = await this.v3.aggregateFeatures(req.itemId, req.layerKey, {
        ...base,
        groupBy: [field.name],
        limit: BREAKDOWN_LIMIT,
      });
      const labels = await this.labelsFor(field, access);
      out.breakdown = {
        fieldLabel: field.label?.trim() || field.name,
        truncated: grouped.truncated,
        rows: grouped.groups
          .map((g) => {
            const code = g.key[field.name] ?? null;
            return toRow(g.values, code === null ? null : (labels.get(code) ?? code));
          })
          // Largest share first, as in the panel.
          .sort((a, b) => (b.measure ?? b.count) - (a.measure ?? a.count)),
      };
    }
    return out;
  }

  /** The same read scope the signed-in aggregate route resolves. */
  private async signedIn(user: AuthUser, req: ReportLayerRequest): Promise<LayerAccess> {
    const item = await this.items.get(user, req.itemId);
    if (item.type !== 'data_layer') throw new NotFoundException();
    const layer = readLayer(item.data, req.layerKey);
    const shares = (item as typeof item & { shares?: ItemShare[] }).shares ?? [];
    const scope = await this.sharing.featureScopeFor(user, item, shares, {
      action: 'read',
      layerPolicy: layer.editingPolicy ?? 'all-rows',
    });
    return {
      layer,
      geoLimit: scope.geoLimit,
      ...(scope.rowScope === 'own' ? { ownRowsOnly: { userId: user.id } } : {}),
      readPickList: async (id) => (await this.items.get(user, id)).data,
    };
  }

  /** The same rule the public aggregate mirror applies. */
  private async anonymous(req: ReportLayerRequest): Promise<LayerAccess> {
    const item = await this.prisma.item.findFirst({
      where: { id: req.itemId, type: 'data_layer', access: 'public', deletedAt: null },
      select: { id: true, data: true, ...PUBLIC_TIER_SELECT },
    });
    if (!item) throw new NotFoundException();
    const layer = readLayer(item.data, req.layerKey);
    return {
      layer,
      geoLimit: await publicTierGeoLimit(this.prisma, item.publicGeoBoundaryId),
      readPickList: async (id) => {
        const pl = await this.prisma.item.findFirst({
          where: { id, access: 'public', deletedAt: null },
          select: { data: true },
        });
        if (!pl) throw new NotFoundException();
        return pl.data;
      },
    };
  }

  /** Code to label, so a breakdown reads like the form that wrote it. */
  private async labelsFor(field: FeatureField, access: LayerAccess): Promise<Map<string, string>> {
    const d = field.domain;
    if (d?.type === 'coded-value') return new Map(d.values.map((v) => [String(v.code), v.label]));
    if (d?.type === 'coded-value-ref') {
      try {
        const data = (await access.readPickList(d.pickListItemId)) as {
          entries?: Array<{ code?: unknown; label?: unknown }>;
        } | null;
        return new Map(
          (data?.entries ?? [])
            .filter((e) => typeof e.label === 'string')
            .map((e) => [String(e.code), e.label as string]),
        );
      } catch {
        // A pick list the caller cannot read leaves the codes.
      }
    }
    return new Map();
  }
}

function readLayer(data: unknown, layerKey: string): V3Layer {
  const d = data as { version?: number; layers?: V3Layer[] } | null;
  if (d?.version !== 3) throw new NotFoundException();
  const layer = d.layers?.find((l) => l.id === layerKey);
  if (!layer) throw new NotFoundException();
  return layer;
}
