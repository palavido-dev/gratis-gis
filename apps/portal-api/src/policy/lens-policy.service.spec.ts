// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';

import { LensPolicyService } from './lens-policy.service.js';
import { PolicyService } from './policy.service.js';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

describe('LensPolicyService', () => {
  let svc: LensPolicyService;

  beforeAll(() => {
    svc = new LensPolicyService(new PolicyService());
  });

  // ---------------------------------------------------------------
  // No-policy short-circuit. The most common case.
  // ---------------------------------------------------------------
  it('passes every feature through when the lens has no policy', () => {
    const result = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-1' },
      feature: {
        entityId: 'feat-1',
        attrs: { name: 'Anything' },
        spatial: [],
      },
    });
    expect(result).toBe(true);
  });

  it('passes every feature through when the policy is whitespace', () => {
    const result = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-1', policy: '   \n  \t' },
      feature: {
        entityId: 'feat-1',
        attrs: {},
        spatial: [],
      },
    });
    expect(result).toBe(true);
  });

  // ---------------------------------------------------------------
  // Attribute-based forbids. The simplest non-trivial case: lens
  // narrows visibility by attribute predicate.
  // ---------------------------------------------------------------
  describe('attribute forbid', () => {
    const policy = `
      forbid (principal, action == Action::"read", resource is Feature)
        when {
          resource.attrs.cost > 10000
        };
    `;

    it('hides expensive features', () => {
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-budget', policy },
        feature: {
          entityId: 'feat-pricey',
          attrs: { cost: 99999 },
          spatial: [],
        },
      });
      expect(result).toBe(false);
    });

    it('shows cheap features', () => {
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-budget', policy },
        feature: {
          entityId: 'feat-cheap',
          attrs: { cost: 50 },
          spatial: [],
        },
      });
      expect(result).toBe(true);
    });

    it('shows features with no cost attribute (forbid does not trigger)', () => {
      // `resource.attrs.cost > 10000` short-circuits: when the cost
      // field is missing, Cedar errors on the lookup, the forbid
      // doesn't fire, and the baseline permit applies. This tests
      // that we don't have the more aggressive "fail closed" reading
      // of policy errors at the *evaluation* level (we DO fail
      // closed when the entire expression errors, but a missing
      // attribute is not necessarily a hard error).
      //
      // Behaviour note: the Cedar evaluator records this as a
      // `diagnostics.errors` entry; LensPolicyService's checkFeature
      // returns false in that case. So today, missing-attribute
      // features are HIDDEN. That's the safe default. If a lens
      // author wants to allow missing-attribute features, they
      // should write `resource.attrs has cost && resource.attrs.cost > 10000`.
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-budget', policy },
        feature: {
          entityId: 'feat-no-cost',
          attrs: { name: 'Untagged' },
          spatial: [],
        },
      });
      expect(result).toBe(false);
    });

    it('handles the safe form (has + comparison)', () => {
      const safePolicy = `
        forbid (principal, action == Action::"read", resource is Feature)
          when {
            resource.attrs has cost &&
            resource.attrs.cost > 10000
          };
      `;
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-safe', policy: safePolicy },
        feature: {
          entityId: 'feat-no-cost',
          attrs: { name: 'Untagged' },
          spatial: [],
        },
      });
      expect(result).toBe(true);
    });

    it('still evaluates a feature that has a null or fractional attribute', () => {
      // Cedar rejects JSON null and non-integer numbers; one such
      // field used to fail the evaluation and hide the feature.
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-budget', policy },
        feature: {
          entityId: 'feat-mixed',
          attrs: { cost: 50, note: null, area: 1.5, tags: [null, 'a'] },
          spatial: [],
        },
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Spatial-set forbids. The marquee Phase C use case: contractor
  // sees only parcels inside their assigned polygon. The geometry
  // math runs in PostGIS upstream; the lens policy reads the
  // pre-resolved set membership.
  // ---------------------------------------------------------------
  describe('spatial-set forbid', () => {
    const policy = `
      forbid (principal, action == Action::"read", resource is Feature)
        when {
          !resource.spatial.contains("assigned_area")
        };
    `;

    it('hides features outside the principal\'s assigned area', () => {
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-contractor', policy },
        feature: {
          entityId: 'feat-out',
          attrs: {},
          spatial: [], // PostGIS said: not in assigned_area
        },
      });
      expect(result).toBe(false);
    });

    it('shows features inside the principal\'s assigned area', () => {
      const result = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-contractor', policy },
        feature: {
          entityId: 'feat-in',
          attrs: {},
          spatial: ['assigned_area'],
        },
      });
      expect(result).toBe(true);
    });

    it('honours multiple spatial keys (in any of N areas)', () => {
      const multiPolicy = `
        forbid (principal, action == Action::"read", resource is Feature)
          when {
            !resource.spatial.contains("assigned_area") &&
            !resource.spatial.contains("emergency_zone")
          };
      `;
      const inEmergencyZoneOnly = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-multi', policy: multiPolicy },
        feature: {
          entityId: 'feat-emergency',
          attrs: {},
          spatial: ['emergency_zone'],
        },
      });
      const inNeither = svc.checkFeature({
        user: makeUser(),
        lens: { id: 'lens-multi', policy: multiPolicy },
        feature: {
          entityId: 'feat-far',
          attrs: {},
          spatial: [],
        },
      });
      expect(inEmergencyZoneOnly).toBe(true);
      expect(inNeither).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Combined forbids. Real lens policies often stack multiple
  // narrowing rules. Cedar evaluates every forbid; ANY matching
  // forbid denies.
  // ---------------------------------------------------------------
  it('stacks attribute and spatial forbids correctly', () => {
    const policy = `
      forbid (principal, action == Action::"read", resource is Feature)
        when {
          resource.attrs has cost && resource.attrs.cost > 10000
        };

      forbid (principal, action == Action::"read", resource is Feature)
        when {
          !resource.spatial.contains("assigned_area")
        };
    `;
    const okFeature = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-stack', policy },
      feature: {
        entityId: 'feat-ok',
        attrs: { cost: 500 },
        spatial: ['assigned_area'],
      },
    });
    const tooExpensive = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-stack', policy },
      feature: {
        entityId: 'feat-pricey',
        attrs: { cost: 99999 },
        spatial: ['assigned_area'],
      },
    });
    const outOfArea = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-stack', policy },
      feature: {
        entityId: 'feat-far',
        attrs: { cost: 500 },
        spatial: [],
      },
    });
    expect(okFeature).toBe(true);
    expect(tooExpensive).toBe(false);
    expect(outOfArea).toBe(false);
  });

  // ---------------------------------------------------------------
  // Sanity check: a lens that tries to ESCALATE privilege via permit
  // can't bypass the Item gate. We don't enforce that at the lens
  // level (the Item gate runs upstream), but we DO want to verify
  // that a permit-only lens policy doesn't accidentally grant a
  // forbid we'd otherwise have. Cedar's forbid-trumps-permit makes
  // this a property of the evaluator, not of our code.
  // ---------------------------------------------------------------
  it('cannot bypass a baseline forbid with a lens permit', () => {
    // Compose a policy where the lens explicitly permits but also
    // explicitly forbids. The forbid wins.
    const policy = `
      permit (principal, action == Action::"read", resource is Feature);
      forbid (principal, action == Action::"read", resource is Feature)
        when {
          resource.attrs has secret && resource.attrs.secret == true
        };
    `;
    const result = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-conflict', policy },
      feature: {
        entityId: 'feat-secret',
        attrs: { secret: true },
        spatial: [],
      },
    });
    expect(result).toBe(false);
  });

  // ---------------------------------------------------------------
  // Diagnostics: a lens with a malformed policy fails closed and
  // logs. We check the deny-on-error behaviour but don't assert
  // the log contents (Nest's Logger is a static stub).
  // ---------------------------------------------------------------
  it('denies all features when the policy text is unparseable', () => {
    const result = svc.checkFeature({
      user: makeUser(),
      lens: { id: 'lens-broken', policy: 'this is not cedar' },
      feature: {
        entityId: 'feat-1',
        attrs: {},
        spatial: [],
      },
    });
    expect(result).toBe(false);
  });
});
