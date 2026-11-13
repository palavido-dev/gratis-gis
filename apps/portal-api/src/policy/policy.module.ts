// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PolicyService } from './policy.service.js';

/**
 * Cedar-policy authorization module. Standalone so callers can
 * depend on it without dragging in items / sharing / prisma.
 *
 * Exports:
 *   - PolicyService -- low-level Cedar evaluator (Phase A); the
 *                      callsite for SharingService's Item-level gate
 *                      (Phase B).
 *
 * The lens row filter (Phase C/D) was removed in the 2026-11 review
 * (08-13): no read path ever applied it and nothing authors lens
 * policies.
 */
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
