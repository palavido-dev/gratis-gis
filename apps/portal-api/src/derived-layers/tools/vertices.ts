import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

export type VerticesParams = Record<string, never>;

/**
 * Vertices generator. Explodes each input geometry into one point
 * feature per vertex via `ST_DumpPoints`. Adds `vertex_index`
 * (0-based) to each output row's properties so downstream tools
 * can reorder, filter, or label by position. Source attributes
 * pass through; the row count goes from 1 to N where N is the
 * vertex count of the input geometry.
 *
 * Useful for "show me the corners" workflows, point-density
 * analysis on traced lines, or as an input to a downstream
 * convex-hull / fishnet step.
 *
 * Note: ST_DumpPoints expands MULTI* and GEOMETRYCOLLECTION inputs
 * across all their parts, so a MultiLineString with two segments
 * yields the union of both segments' vertices.
 */
export const verticesGenerator: ToolGenerator<VerticesParams> = {
  kind: 'vertices',

  validate(raw: unknown): VerticesParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('vertices.params must be an object');
    }
    return {} as VerticesParams;
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Source schema plus a synthetic `vertex_index` integer field.
    // Returning a fresh array (not mutating the input) keeps the
    // pipeline pure.
    return [
      ...input,
      {
        name: 'vertex_index',
        label: 'Vertex index',
        type: 'number',
        nullable: false,
      },
    ];
  },

  outwardReachMeters(): number {
    // Vertices lie on the input geometry; output bbox is bounded
    // by the input bbox.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    // ST_DumpPoints returns rows of (path int[], geom geometry). The
    // path is an array describing the location within the geometry
    // (e.g. [1, 3] = third vertex of first ring); ordering by path
    // gives a stable, sensible flat index across simple AND nested
    // shapes (MultiPolygon, GeometryCollection). The OVER () window
    // is per-input-row because of the LATERAL, so vertex_index
    // resets at each input.
    //
    // global_id reuses the source row's id; downstream readers
    // disambiguate vertices via (global_id, vertex_index). Adding a
    // synthesized per-vertex unique id would make downstream tools
    // treat each vertex as a distinct entity for identity purposes,
    // which is the wrong default for a "show me the corners" tool.
    const sql = `
      SELECT
        ${inputAlias}.global_id,
        ST_SetSRID(dp.geom, 4326) AS geom,
        ${inputAlias}.properties
          || jsonb_build_object('vertex_index', dp.vertex_index)
          AS properties
      FROM ${inputAlias},
      LATERAL (
        SELECT
          pt.geom,
          (ROW_NUMBER() OVER (ORDER BY pt.path)) - 1 AS vertex_index
        FROM ST_DumpPoints(${inputAlias}.geom) AS pt
      ) dp
      WHERE ${inputAlias}.geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
