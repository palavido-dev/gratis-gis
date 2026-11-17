// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

// cedar-wasm/nodejs is a CommonJS bundle that ships its own .d.ts
// shim. Importing it as `* as` avoids a default-export interop
// quirk in @cedar-policy/cedar-wasm 4.x.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The shape of an authorization request the engine asks Cedar to
 * evaluate. Mirrors the AWS Cedar API but keeps the wire shape
 * stable for portal callsites: changing Cedar versions or moving
 * to OPA in a follow-up doesn't ripple into every controller.
 */
export interface PolicyCheckRequest {
  /**
   * Required. The principal asserting the action. The portal
   * always passes a `User` entity with the JWT `sub` as id.
   */
  principal: PolicyEntityRef;
  /**
   * Required. The action being attempted. Portal vocabulary:
   *   { type: 'Action', id: 'read' | 'edit' | 'admin' | 'delete' | 'download' }
   */
  action: PolicyEntityRef;
  /**
   * Required. The resource being acted on. Portal vocabulary:
   *   { type: 'Item', id: '<uuid>' } for item-level checks
   *   { type: 'Lens', id: '<uuid>' } for lens-level checks
   *   { type: 'Feature', id: '<entityUuid>' } for row-level checks
   */
  resource: PolicyEntityRef;
  /**
   * Optional context attributes. Geometry-aware policies pull
   * `context.feature_geom` (GeoJSON) and `context.now` (ISO
   * timestamp) here. The engine fills these in for spatial /
   * temporal predicates the lens declares.
   */
  context?: Record<string, unknown>;
  /**
   * Optional override for the entity store. The portal builds
   * the default store from the principal + resource on every
   * check (cheap, single-org per-request) and merges anything
   * the caller passes in. Lens reads with row-level policies
   * pass per-feature attrs through here.
   */
  entities?: PolicyEntity[];
  /**
   * Optional override for the policies. Defaults to the static
   * org-membership policies. A lens with custom policies passes
   * them in here verbatim; the engine prepends the static
   * baseline so a misauthored lens policy can't escalate
   * privilege past the platform default.
   */
  policiesText?: string;
}

export interface PolicyEntityRef {
  type: string;
  id: string;
}

export interface PolicyEntity {
  uid: PolicyEntityRef;
  attrs?: Record<string, unknown>;
  parents?: PolicyEntityRef[];
}

export type PolicyDecision = 'allow' | 'deny';

export interface PolicyCheckResult {
  decision: PolicyDecision;
  /**
   * Cedar's `reason` list (policy ids that produced the
   * decision). Useful for debugging "why was I denied?"; the API
   * surfaces this in dev mode only.
   */
  reasons: string[];
  /**
   * Errors raised during evaluation. A non-empty list does NOT
   * imply deny by itself: Cedar's semantics are that a runtime
   * error in one policy is ignored if another policy permits.
   * The engine logs these so misauthored lenses surface in the
   * server log instead of silently failing closed.
   */
  errors: string[];
}

/**
 * Cedar-policy-backed authorization. SharingService's checks
 * (canRead and the rest) delegate their decision to this service.
 *
 * The current implementation is intentionally narrow:
 * `check()` evaluates a fixed baseline policy
 * (org-membership-only, mirroring SharingService.canRead's
 * `access === 'org' && orgId match` branch) plus any policy
 * text the caller passes through. Cedar's WASM is loaded
 * eagerly at module construction; the binding is synchronous
 * so no async init step is needed.
 */
@Injectable()
export class PolicyService {
  private readonly log = new Logger(PolicyService.name);

  constructor() {
    // cedar-wasm exposes synchronous functions; the WASM binary
    // loads on first call. Probe early so a startup failure
    // surfaces at module load instead of on the first
    // authorization check.
    try {
      const sdk = cedar.getCedarSDKVersion();
      const lang = cedar.getCedarLangVersion();
      this.log.log(`Cedar engine ready (sdk=${sdk}, lang=${lang})`);
    } catch (err) {
      this.log.error(
        `Cedar engine failed to initialise: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw err;
    }
  }

  /**
   * Run an authorization check. Returns `decision: 'allow'` only
   * when at least one policy permits and no policy forbids
   * (Cedar's standard semantics: explicit forbids beat permits;
   * silence is deny).
   */
  check(req: PolicyCheckRequest): PolicyCheckResult {
    const policies = req.policiesText ?? DEFAULT_POLICY_TEXT;
    // Cedar's published TypeScript types model `context` and
    // entity `attrs` as a strict CedarValueJson recursive shape;
    // our wire types use plain `Record<string, unknown>` so
    // existing portal callsites don't have to import cedar types
    // to build a request. Cast at the boundary; the runtime
    // accepts plain JSON objects (verified via the spec suite
    // and the cedar-probe smoke test).
    const result = cedar.isAuthorized({
      principal: req.principal,
      action: req.action,
      resource: req.resource,
      context: (req.context ?? {}) as Parameters<
        typeof cedar.isAuthorized
      >[0]['context'],
      policies: { staticPolicies: policies },
      entities: (req.entities ?? []) as Parameters<
        typeof cedar.isAuthorized
      >[0]['entities'],
    });
    if (result.type === 'failure') {
      const messages = (result.errors ?? []).map((e) => cedarErrorMessage(e));
      this.log.warn(
        `Cedar check failed for ${req.principal.type}::${req.principal.id} ` +
          `${req.action.type}::${req.action.id} ` +
          `${req.resource.type}::${req.resource.id}: ${messages.join('; ')}`,
      );
      return { decision: 'deny', reasons: [], errors: messages };
    }
    const response = result.response;
    return {
      decision: response.decision === 'allow' ? 'allow' : 'deny',
      reasons: response.diagnostics?.reason ?? [],
      errors: (response.diagnostics?.errors ?? []).map((e) =>
        cedarErrorMessage(e),
      ),
    };
  }
}

/**
 * Pull a human-readable string out of one of Cedar's diagnostic
 * error shapes. The published TypeScript types model errors as
 * a discriminated union with a top-level `message`; the runtime
 * shape Cedar emits for evaluation diagnostics actually nests
 * `message` one level deeper under `error.message` (the outer
 * object is `{policyId, error: AuthorizationError}`). We probe
 * both shapes plus a `text` fallback so misauthored policies
 * surface useful logs instead of "[object Object]".
 */
function cedarErrorMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return String(raw);
  const obj = raw as Record<string, unknown>;
  const direct = obj.message;
  if (typeof direct === 'string') return direct;
  const nested = (obj.error as { message?: unknown } | undefined)?.message;
  if (typeof nested === 'string') return nested;
  const text = obj.text;
  if (typeof text === 'string') return text;
  return JSON.stringify(raw);
}

/**
 * Baseline policy text. Mirrors SharingService.canRead / canEdit /
 * canDownload / canAdmin verbatim so Phase B can migrate those
 * methods onto PolicyService.check without changing any answer.
 *
 * Action vocabulary the portal uses (must match what callers pass
 * as `req.action.id`):
 *   - "read"     -- canRead path; gates the visibility surface
 *                   (item detail, layer features, popups,
 *                   attribute table reads).
 *   - "download" -- canDownload path; gates GeoJSON / CSV /
 *                   GeoPackage bulk extracts.
 *   - "edit"     -- canEdit path; gates attribute / geometry
 *                   edits, schema mutations, ingest, share/unshare.
 *   - "admin"    -- canAdmin path; gates ownership reassignment
 *                   and purge. Owner / org-admin only; no share
 *                   grant promotes a recipient into this tier.
 *
 * Item entity attributes the EntityStore writes (see entity-store.ts):
 *   - owner       : User entity ref
 *   - org         : Org entity ref
 *   - access      : "private" | "org" | "public"
 *   - viewers     : Set<User> -- has the calling user iff they
 *                   match a non-expired share at any tier
 *   - downloaders : Set<User> -- same, at download tier or higher
 *   - editors     : Set<User> -- same, at edit tier or higher
 */
export const DEFAULT_POLICY_TEXT = `
// 1. Owners can do anything to their own items. The portal's
//    EntityStore writes resource.owner as an entity reference
//    (User::"<uuid>"), not as a plain string, so an entity-ref
//    comparison is what matches; principal.id and similar
//    attribute lookups are NOT available in Cedar (the entity uid
//    is only reachable via == against another entity literal).
permit (
  principal,
  action,
  resource
) when {
  resource has owner &&
  principal == resource.owner
};

// 2. Org admins can do anything to items inside their org. Both
//    principal.org and resource.org are entity refs
//    (Org::"<uuid>") so the equality check is between two entity
//    literals, not between strings.
permit (
  principal,
  action,
  resource
) when {
  resource has org &&
  principal has org &&
  principal.org == resource.org &&
  principal has role &&
  principal.role == "admin"
};

// 3. Public items are readable by anyone authenticated.
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has access &&
  resource.access == "public"
};

// 4. Org-access items are readable by org members.
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has access &&
  resource.access == "org" &&
  resource has org &&
  principal has org &&
  principal.org == resource.org
};

// 5. Public items are downloadable by anyone authenticated.
permit (
  principal,
  action == Action::"download",
  resource
) when {
  resource has access &&
  resource.access == "public"
};

// 6. Org-access items are downloadable by org members.
permit (
  principal,
  action == Action::"download",
  resource
) when {
  resource has access &&
  resource.access == "org" &&
  resource has org &&
  principal has org &&
  principal.org == resource.org
};

// 7. Explicit view-tier (or higher) share grants read.
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has viewers &&
  resource.viewers.contains(principal)
};

// 8. Explicit download-tier (or higher) share grants download.
permit (
  principal,
  action == Action::"download",
  resource
) when {
  resource has downloaders &&
  resource.downloaders.contains(principal)
};

// 9. Explicit edit-tier (or admin-tier) share grants edit.
permit (
  principal,
  action == Action::"edit",
  resource
) when {
  resource has editors &&
  resource.editors.contains(principal)
};

// Note: there is deliberately NO Action::"admin" permit beyond
// rules 1 and 2. SharingService.canAdmin is owner-/org-admin-
// only by design; even an "admin"-tier share recipient cannot
// reassign ownership or purge the item. To grant those, transfer
// ownership instead.
`;
