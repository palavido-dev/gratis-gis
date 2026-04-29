import type { FeatureField } from '@gratis-gis/shared-types';

/**
 * Common shape every tool generator produces from `toSql`. The
 * backing string is a SQL fragment, parameterized through `$N`
 * placeholders, that defines a single CTE-style subquery yielding the
 * tool's output rows.
 *
 * Generators NEVER inline user-controlled values into `sql`.
 * Everything goes through `params`, which the service appends to the
 * outer query's parameter list before execution. Generators are also
 * trusted to avoid quoting user-supplied identifiers (column names,
 * table aliases) directly; the registry hands generators the alias to
 * select from, so the tool only emits hand-authored SQL plus
 * placeholders.
 */
export interface ToolSqlFragment {
  /**
   * SQL for one CTE body (the `(...)` after `WITH step_N AS`). Must
   * select `geom`, `global_id`, and the attribute columns declared by
   * `outputSchema`. Reads from the input via the `inputAlias` passed
   * to `toSql`.
   */
  sql: string;
  /**
   * Parameter values referenced by `$N` placeholders inside `sql`.
   * Numbering inside `sql` starts at `paramOffset + 1`; the service
   * appends these to the outer query's parameter array as-is.
   */
  params: unknown[];
}

/**
 * Item-id / url references a tool's params hold. Returned to the
 * dependency extractor so the derived layer's forward edges include
 * everything the recipe references, not just `source.itemId`.
 *
 * v1 buffer returns empty arrays; future tools (intersect's second
 * input layer, choices that pull from a pick_list) populate this.
 */
export interface ToolDependencies {
  itemIds: string[];
  urls: string[];
}

/**
 * Per-tool contract. One file in this folder per tool. Adding a new
 * tool is purely additive: drop a generator here, register it in
 * `registry.ts`, add the param shape to `ToolStep` in shared-types,
 * and add a wizard step in portal-web. No schema migration, no
 * touchpoint outside these files.
 *
 * Type parameters:
 *   - `TParams` is the strongly-typed param shape. The discriminator
 *     in the union (`tool: 'buffer'`) gates which generator runs.
 */
export interface ToolGenerator<TParams> {
  /** Stable identifier; matches the discriminator in `ToolStep`. */
  readonly kind: string;

  /**
   * Hand-authored validator. Throws `BadRequestException` (or returns
   * a list of human-readable errors as a `ValidationError[]`) when
   * params don't match the declared shape. The registry calls this
   * before any other generator method, so other methods can assume
   * params are well-formed.
   */
  validate(params: unknown): TParams;

  /**
   * Compute the output schema from the input schema + params. Pure.
   * Called at save time to populate `data.outputSchema`. For tools
   * that don't change the shape (e.g. buffer), returns the input
   * schema unchanged.
   */
  outputSchema(input: FeatureField[], params: TParams): FeatureField[];

  /**
   * Maximum distance (meters) this tool can grow geometries outward.
   * Used by the read path to expand the source bbox before the
   * pipeline runs, so features near tile edges retain their halo.
   * Most tools return 0; buffer returns `params.distance`. The
   * pipeline's total reach is the sum of its steps.
   */
  outwardReachMeters(params: TParams): number;

  /**
   * Item references the tool's params hold (other layers, pick
   * lists, ...). The dependency extractor merges these into the
   * derived layer's forward edges, so the dependency graph stays
   * complete as new tools arrive.
   */
  extractDependencies(params: TParams): ToolDependencies;

  /**
   * Emit the SQL CTE body for this tool. Must:
   *   - read input rows from `inputAlias` (a CTE name picked by the
   *     service: `source` for step 0's input, `step_N` for step N's
   *     input).
   *   - select `geom` (PostGIS geometry, SRID 4326), `global_id`,
   *     and every attribute column declared by `outputSchema(...)`.
   *   - reference user-supplied values only through `$N`
   *     placeholders. `paramOffset` is the count of parameters
   *     already in the outer query; the first placeholder a tool
   *     emits is `$${paramOffset + 1}`.
   */
  toSql(
    inputAlias: string,
    params: TParams,
    paramOffset: number,
  ): ToolSqlFragment;
}
