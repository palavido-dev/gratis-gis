// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  PolicyService,
  type PolicyEntity,
} from './policy.service.js';

/**
 * Pre-resolved spatial predicate. The caller computes these from
 * PostGIS (ST_Within / ST_Intersects / ST_DWithin / ...) before
 * dispatching to Cedar; the engine then sees them as plain boolean
 * set membership inside a string-keyed Set, which Cedar's published
 * WASM bundle can evaluate natively.
 *
 * Convention: keys are lower-snake-case identifiers chosen by the
 * lens author and resolved by the read pipeline. Examples:
 *   "assigned_area"      -- the calling user's assigned polygon
 *   "service_area:fire"  -- a named service area
 *   "boundary:abc123"    -- a specific geo_boundary item id
 *
 * The lens policy references the same key strings:
 *   forbid (principal, action == Action::"read", resource is Feature)
 *     when { !resource.spatial.contains("assigned_area") };
 */
export type SpatialKey = string;

/**
 * Per-feature read input the lens policy is evaluated against.
 * The caller fills `attrs` with the feature's properties and
 * `spatial` with the set of spatial keys this feature qualifies
 * for given the calling user (i.e. the result of the PostGIS
 * containment check, distilled to keys).
 */
export interface FeatureReadContext {
  /** Stable id of the feature (the engine's `entity` UUID). */
  entityId: string;
  /** Feature attribute payload. JSONB equivalent. */
  attrs: Record<string, unknown>;
  /** Spatial keys the feature qualifies for under this principal. */
  spatial: SpatialKey[];
}

/**
 * Lens-level policy. v1 stores the Cedar policy text inline on the
 * Lens; future versions can split per-lens entity stores out into
 * the engine's `policy` table. The `id` is used as a Cedar policy
 * source label for diagnostics.
 */
export interface LensPolicyInput {
  /** Lens id, surfaced in Cedar diagnostics. */
  id: string;
  /**
   * Cedar policy text. Empty / undefined means "no row-level
   * filtering"; the call short-circuits to allow.
   */
  policy?: string;
}

/**
 * Phase C of the Cedar integration: lens-level custom policies.
 * Sits between the Item-level gate (Phase B's SharingService) and
 * the read pipeline. The Item gate decides whether the principal
 * can use the lens at all; this service decides whether each
 * individual row in the lens output is visible to the principal.
 *
 * Architecture:
 *
 *   1. Caller verifies `SharingService.canRead(user, item)`. Failure
 *      -> 403; LensPolicyService is never called.
 *   2. Caller pre-computes spatial predicates per feature in
 *      PostGIS. Cedar's published WASM doesn't ship a geometry
 *      extension; we evaluate `ST_Within(...)` / similar in SQL,
 *      distill to a Set<string>, hand the set to Cedar.
 *   3. Caller invokes `checkFeature` per feature; this combines an
 *      implicit "allowed past the Item gate" baseline with the
 *      lens's policy text and runs the Cedar evaluator. forbid
 *      rules in the lens text subtract from the baseline.
 *   4. Rows that come back `decision: 'deny'` are filtered out of
 *      the response.
 *
 * Cedar's forbid-trumps-permit semantics is the load-bearing
 * property: the lens policy can only *narrow* what the user can
 * see, never broaden. A misauthored lens that accidentally writes
 * `permit (principal, action, resource);` cannot let a viewer see
 * data they couldn't see at the Item level, because the Item-level
 * gate already happened upstream.
 *
 * No-policy case: a lens with `policy === undefined` (or empty
 * string) is a passthrough; every feature the read pipeline emits
 * is allowed. We short-circuit before constructing the entity
 * store so a no-policy lens reads at the same speed as before.
 */
@Injectable()
export class LensPolicyService {
  private readonly log = new Logger(LensPolicyService.name);

  constructor(private readonly policy: PolicyService) {}

  /**
   * Evaluate a single feature against the lens's row-level policy.
   * Returns true when the feature is visible to the principal,
   * false when it should be filtered out.
   *
   * Throws on a Cedar parse failure (the lens has malformed policy
   * text). Runtime evaluation errors fail closed (return false)
   * and are logged so the operator sees authoring mistakes without
   * silently leaking data.
   */
  checkFeature(args: {
    user: AuthUser;
    lens: LensPolicyInput;
    feature: FeatureReadContext;
  }): boolean {
    const { user, lens, feature } = args;
    if (!lens.policy || lens.policy.trim().length === 0) {
      return true;
    }

    const policiesText = combinePolicyText(lens.policy);
    const entities: PolicyEntity[] = [
      {
        uid: { type: 'User', id: user.id },
        attrs: {
          org: { __entity: { type: 'Org', id: user.orgId } },
          role: user.orgRole,
        },
        parents: [{ type: 'Org', id: user.orgId }],
      },
      {
        uid: { type: 'Org', id: user.orgId },
        attrs: {},
        parents: [],
      },
      {
        uid: { type: 'Feature', id: feature.entityId },
        attrs: {
          attrs: cedarValueFromAttrs(feature.attrs),
          spatial: feature.spatial,
          lensId: lens.id,
        },
        parents: [],
      },
    ];

    const result = this.policy.check({
      principal: { type: 'User', id: user.id },
      action: { type: 'Action', id: 'read' },
      resource: { type: 'Feature', id: feature.entityId },
      entities,
      policiesText,
    });

    if (result.errors.length > 0) {
      // Runtime evaluation errors (not parse errors -- those would
      // come through as result.decision='deny' from a failure-typed
      // Cedar response). Log so the lens author can see what their
      // policy did at runtime; deny by default.
      this.log.warn(
        `Lens ${lens.id} runtime errors on feature ${feature.entityId}: ${result.errors.join('; ')}`,
      );
      return false;
    }
    return result.decision === 'allow';
  }
}

/**
 * Compose the Cedar evaluation set: an implicit feature-level
 * baseline that allows everything (the Item gate already happened
 * upstream) plus the lens's own policy text. forbid rules in the
 * lens text subtract from the baseline; permit rules in the lens
 * text are redundant but harmless (they would re-allow what the
 * baseline already allows).
 */
function combinePolicyText(lensPolicy: string): string {
  return `
    // Phase C feature-level baseline. The caller already verified
    // SharingService.canRead at the Item level before dispatching
    // here, so every Feature::"<entity>" the read pipeline emits
    // is allowed by default. Lens-attached forbid rules subtract.
    permit (
      principal,
      action == Action::"read",
      resource is Feature
    );

    // Lens custom policy (forbid rules narrow the baseline).
    ${lensPolicy}
  `;
}

/**
 * Map a Record<string, unknown> attribute payload to a CedarValueJson-
 * shaped Record so the evaluator can read individual fields with
 * `resource.attrs.<fieldname>`. Cedar's published types reject
 * `unknown` here; the runtime accepts plain JSON. The shallow shape
 * is sufficient for the v1 lens-policy use cases (numeric / string
 * / boolean comparisons against scalar attrs); nested objects pass
 * through but Cedar can't usefully introspect them today.
 */
function cedarValueFromAttrs(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  // Cedar refuses JSON null and any number that is not a 64-bit
  // integer, and one refused attribute fails the whole evaluation,
  // which reads as a deny. So every feature with an empty field or a
  // float (area, length) was hidden under any policy. Nulls are left
  // out; fractions become Cedar decimals.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const c = toCedarValue(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function toCedarValue(v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    if (Number.isSafeInteger(v)) return v;
    // Cedar decimal: four fractional digits, about +-9.2e14.
    if (Math.abs(v) < 9e14) return { __extn: { fn: 'decimal', arg: v.toFixed(4) } };
    return String(v);
  }
  if (Array.isArray(v)) {
    return v.map(toCedarValue).filter((x) => x !== undefined);
  }
  if (typeof v === 'object') {
    return cedarValueFromAttrs(v as Record<string, unknown>);
  }
  return v;
}
