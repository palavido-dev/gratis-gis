import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Persistence and access control for form submissions (#131).
 *
 * Idempotency: writes go through `upsert` keyed on (formId, clientId)
 * so a re-drained offline queue is a no-op rather than a duplicate.
 *
 * Access control today:
 *   - The respondent must be able to see the form item (either by
 *     ownership, by share, or by org-wide access). We piggyback on
 *     the existing item visibility rules: if you can read the form,
 *     you can submit to it. Phase 2 introduces explicit "respondent"
 *     vs "viewer" share tiers.
 *   - Listing submissions requires either ownership of the form or
 *     org-admin role.
 */
@Injectable()
export class FormsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fetch the form item, gating by visibility for the caller. Used
   *  to look up the orgId we'll stamp on the submission. */
  private async getVisibleForm(formId: string, user: AuthUser) {
    const item = await this.prisma.item.findUnique({
      where: { id: formId },
      select: { id: true, type: true, orgId: true, ownerId: true, access: true },
    });
    if (!item || item.type !== 'form') {
      throw new NotFoundException('Form not found.');
    }
    // Same org check is the cheap baseline. Org-wide-public forms
    // pass; private forms only pass when the respondent has a share.
    if (item.orgId !== user.orgId) {
      throw new ForbiddenException('Form is not in your organization.');
    }
    if (item.access === 'private' && item.ownerId !== user.id) {
      const share = await this.prisma.itemShare.findFirst({
        where: {
          itemId: item.id,
          OR: [
            { principalType: 'user', principalId: user.id },
            {
              principalType: 'group',
              principalId: { in: user.groupIds },
            },
          ],
        },
        select: { itemId: true },
      });
      if (!share) {
        throw new ForbiddenException('You do not have access to this form.');
      }
    }
    return item;
  }

  async submit(
    formId: string,
    user: AuthUser,
    dto: {
      clientId: string;
      schemaVersion: number;
      response: Record<string, unknown>;
      capturedAt: string;
    },
  ): Promise<{ id: string; created: boolean }> {
    const form = await this.getVisibleForm(formId, user);
    const captured = new Date(dto.capturedAt);
    if (Number.isNaN(captured.getTime())) {
      throw new ForbiddenException('Invalid capturedAt.');
    }
    const result = await this.prisma.formSubmission.upsert({
      where: { formId_clientId: { formId: form.id, clientId: dto.clientId } },
      create: {
        formId: form.id,
        orgId: form.orgId,
        clientId: dto.clientId,
        schemaVersion: dto.schemaVersion,
        response: dto.response as Prisma.InputJsonValue,
        submittedBy: user.id,
        capturedAt: captured,
      },
      update: {}, // idempotent on re-drain; never overwrite a stored row
      select: { id: true, createdAt: true },
    });
    // `created` is true only when the row didn't already exist -- we
    // proxy it via createdAt being equal to "right now" within
    // tolerance, which is good enough for the UI and avoids a second
    // query. Phase 2 may switch to a tx-level WAS-CREATED flag.
    const justCreated =
      Date.now() - result.createdAt.getTime() < 5_000;
    return { id: result.id, created: justCreated };
  }

  async list(
    formId: string,
    user: AuthUser,
    opts: { limit?: number } = {},
  ): Promise<
    Array<{
      id: string;
      clientId: string;
      response: unknown;
      submittedBy: string | null;
      capturedAt: string;
      createdAt: string;
      schemaVersion: number;
    }>
  > {
    const form = await this.getVisibleForm(formId, user);
    if (form.ownerId !== user.id && user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only the form owner or an org admin can view submissions.',
      );
    }
    const rows = await this.prisma.formSubmission.findMany({
      where: { formId: form.id },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(opts.limit ?? 100, 500)),
      select: {
        id: true,
        clientId: true,
        response: true,
        submittedBy: true,
        capturedAt: true,
        createdAt: true,
        schemaVersion: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      response: r.response,
      submittedBy: r.submittedBy,
      capturedAt: r.capturedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      schemaVersion: r.schemaVersion,
    }));
  }

  async count(formId: string, user: AuthUser): Promise<number> {
    const form = await this.getVisibleForm(formId, user);
    if (form.ownerId !== user.id && user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only the form owner or an org admin can view submission counts.',
      );
    }
    return this.prisma.formSubmission.count({ where: { formId: form.id } });
  }
}
