// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { OsmService } from './osm.service.js';
import {
  OSM_QUERY_MAX_CONDITIONS,
  OSM_QUERY_MAX_PRESETS,
  validateOsmQueryBounds,
} from './osm-query.limits.js';
import type { OsmGeoJsonFeature } from './osm-to-geojson.js';

type TagFilter = {
  key: string;
  value: string;
  op?: 'equals' | 'contains' | 'regex';
};

type RelationalCondition = {
  presetId: string;
  distanceMeters: number;
  tagFilters?: TagFilter[];
};

/**
 * Authenticated OSM Overpass query surface for MCP + scripts.
 *
 * GET (not POST) so a read-only portal API key can call it — the
 * read-only gate is method-based (#219). Thin facade over
 * OsmService.resolve / resolveRelational; per-org
 * osmOverpassEndpoint is honored when the caller has an orgId.
 *
 * Caps (bbox area + feature count) live in osm-query.limits.ts so
 * unbounded / continent-scale queries never reach Overpass.
 */
@ApiTags('osm')
@ApiBearerAuth()
@Controller('osm')
export class OsmQueryController {
  constructor(private readonly osm: OsmService) {}

  @Get('query')
  async query(
    @CurrentUser() user: AuthUser,
    @Query('bbox') bboxRaw?: string,
    @Query('presetIds') presetIdsRaw?: string,
    @Query('tagFilters') tagFiltersRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('mode') modeRaw?: string,
    @Query('anchorPresetId') anchorPresetId?: string,
    @Query('conditions') conditionsRaw?: string,
    @Query('negations') negationsRaw?: string,
  ): Promise<{
    type: 'FeatureCollection';
    features: OsmGeoJsonFeature[];
    attribution: string;
    featureCount: number;
    truncated: boolean;
    mode: 'presets' | 'relational';
    cacheHit?: boolean;
  }> {
    if (!user) {
      throw new BadRequestException('Authentication required.');
    }

    const bounds = validateOsmQueryBounds({
      bbox: bboxRaw,
      limit: limitRaw,
    });
    if (!bounds.ok) {
      throw new BadRequestException(bounds.message);
    }

    const mode =
      modeRaw === 'relational' || modeRaw === 'presets'
        ? modeRaw
        : anchorPresetId
          ? 'relational'
          : 'presets';

    try {
      if (mode === 'relational') {
        return await this.runRelational(user, bounds, {
          ...(anchorPresetId !== undefined ? { anchorPresetId } : {}),
          ...(conditionsRaw !== undefined ? { conditionsRaw } : {}),
          ...(negationsRaw !== undefined ? { negationsRaw } : {}),
        });
      }
      return await this.runPresets(user, bounds, {
        ...(presetIdsRaw !== undefined ? { presetIdsRaw } : {}),
        ...(tagFiltersRaw !== undefined ? { tagFiltersRaw } : {}),
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const looksOverloaded =
        /timed out|timeout|too many requests|429|504|Overpass rejected|rejected the query|overloaded/i.test(
          msg,
        );
      if (looksOverloaded) {
        throw new BadRequestException(
          'The OSM query was too large or complex for Overpass to finish. Try a smaller bbox, fewer presets or conditions, or a lower limit.',
        );
      }
      throw new BadRequestException(msg);
    }
  }

  private async runPresets(
    user: AuthUser,
    bounds: Extract<ReturnType<typeof validateOsmQueryBounds>, { ok: true }>,
    args: { presetIdsRaw?: string; tagFiltersRaw?: string },
  ) {
    const presetIds = parseCsvIds(args.presetIdsRaw);
    if (presetIds.length === 0) {
      throw new BadRequestException(
        'presetIds is required for mode=presets (comma-separated iD preset ids, e.g. amenity_fuel,leisure_park).',
      );
    }
    if (presetIds.length > OSM_QUERY_MAX_PRESETS) {
      throw new BadRequestException(
        `At most ${OSM_QUERY_MAX_PRESETS} presetIds per query.`,
      );
    }
    const tagFilters = parseTagFilters(args.tagFiltersRaw);

    const result = await this.osm.resolve({
      presetIds,
      ...(tagFilters ? { tagFilters } : {}),
      bbox: bounds.bbox,
      maxFeatures: bounds.maxFeatures,
      ...(user.orgId ? { orgId: user.orgId } : {}),
    });

    const features = result.features.slice(0, bounds.maxFeatures);
    return {
      type: 'FeatureCollection' as const,
      features,
      attribution: result.attribution,
      featureCount: features.length,
      truncated: result.featureCount > features.length,
      mode: 'presets' as const,
      cacheHit: result.cacheHit,
    };
  }

  private async runRelational(
    user: AuthUser,
    bounds: Extract<ReturnType<typeof validateOsmQueryBounds>, { ok: true }>,
    args: {
      anchorPresetId?: string;
      conditionsRaw?: string;
      negationsRaw?: string;
    },
  ) {
    const anchor = (args.anchorPresetId ?? '').trim();
    if (!anchor) {
      throw new BadRequestException(
        'anchorPresetId is required for mode=relational.',
      );
    }
    const conditions = parseConditions(args.conditionsRaw);
    if (conditions.length === 0) {
      throw new BadRequestException(
        'conditions is required for mode=relational (JSON array of {presetId, distanceMeters}).',
      );
    }
    if (conditions.length > OSM_QUERY_MAX_CONDITIONS) {
      throw new BadRequestException(
        `At most ${OSM_QUERY_MAX_CONDITIONS} relational conditions per query.`,
      );
    }
    const negations = parseNegations(args.negationsRaw);

    const result = await this.osm.resolveRelational({
      anchorPresetId: anchor,
      conditions,
      ...(negations ? { negations } : {}),
      bbox: bounds.bbox,
      maxFeatures: bounds.maxFeatures,
      ...(user.orgId ? { orgId: user.orgId } : {}),
    });

    // Flatten anchor + supporting into one FeatureCollection for MCP
    // consumers; properties keep osm element ids for follow-up writes.
    const merged: OsmGeoJsonFeature[] = [
      ...result.anchor.features,
      ...result.supporting,
    ].slice(0, bounds.maxFeatures);

    return {
      type: 'FeatureCollection' as const,
      features: merged,
      attribution: result.attribution,
      featureCount: merged.length,
      truncated: result.featureCount > merged.length,
      mode: 'relational' as const,
    };
  }
}

function parseCsvIds(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseTagFilters(raw?: string): TagFilter[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestException(
      'tagFilters must be a JSON array of {key, value, op?}.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException(
      'tagFilters must be a JSON array of {key, value, op?}.',
    );
  }
  const out: TagFilter[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new BadRequestException('Each tagFilter must be an object.');
    }
    const key = (item as { key?: unknown }).key;
    const value = (item as { value?: unknown }).value;
    const op = (item as { op?: unknown }).op;
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new BadRequestException(
        'Each tagFilter needs string key and value.',
      );
    }
    const filter: TagFilter = { key, value };
    if (op === 'equals' || op === 'contains' || op === 'regex') {
      filter.op = op;
    }
    out.push(filter);
  }
  return out.length > 0 ? out : undefined;
}

function parseConditions(raw?: string): RelationalCondition[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestException(
      'conditions must be a JSON array of {presetId, distanceMeters}.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException(
      'conditions must be a JSON array of {presetId, distanceMeters}.',
    );
  }
  const out: RelationalCondition[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new BadRequestException('Each condition must be an object.');
    }
    const presetId = (item as { presetId?: unknown }).presetId;
    const distanceMeters = (item as { distanceMeters?: unknown })
      .distanceMeters;
    if (typeof presetId !== 'string' || !presetId.trim()) {
      throw new BadRequestException('Each condition needs a presetId string.');
    }
    const dist =
      typeof distanceMeters === 'number'
        ? distanceMeters
        : Number(distanceMeters);
    if (!Number.isFinite(dist) || dist <= 0) {
      throw new BadRequestException(
        'Each condition needs a positive distanceMeters.',
      );
    }
    const cond: RelationalCondition = {
      presetId: presetId.trim(),
      distanceMeters: dist,
    };
    const tagFiltersRaw = (item as { tagFilters?: unknown }).tagFilters;
    if (tagFiltersRaw !== undefined) {
      const tf = parseTagFilters(JSON.stringify(tagFiltersRaw));
      if (tf) cond.tagFilters = tf;
    }
    out.push(cond);
  }
  return out;
}

function parseNegations(
  raw?: string,
): Array<{ presetId: string; distanceMeters: number }> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestException(
      'negations must be a JSON array of {presetId, distanceMeters}.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException(
      'negations must be a JSON array of {presetId, distanceMeters}.',
    );
  }
  const out: Array<{ presetId: string; distanceMeters: number }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new BadRequestException('Each negation must be an object.');
    }
    const presetId = (item as { presetId?: unknown }).presetId;
    const distanceMeters = (item as { distanceMeters?: unknown })
      .distanceMeters;
    if (typeof presetId !== 'string' || !presetId.trim()) {
      throw new BadRequestException('Each negation needs a presetId string.');
    }
    const dist =
      typeof distanceMeters === 'number'
        ? distanceMeters
        : Number(distanceMeters);
    if (!Number.isFinite(dist) || dist <= 0) {
      throw new BadRequestException(
        'Each negation needs a positive distanceMeters.',
      );
    }
    out.push({ presetId: presetId.trim(), distanceMeters: dist });
  }
  return out.length > 0 ? out : undefined;
}
