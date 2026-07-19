// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SystemSettingsService } from '../notifications/system-settings.service.js';

/**
 * Admin getting-started checklist (#147 Phase 3).
 *
 * The checklist deliberately derives done-ness from live system
 * state wherever it can rather than storing checkmarks: "set up
 * email" is done when SMTP is actually configured and enabled,
 * "invite your team" is done when the org actually has more than
 * one member, "make your first map" is done when a map or the
 * sample scenario actually exists. Stored ticks drift from
 * reality (an admin who configures SMTP from env vars would be
 * nagged forever; one who ticks the box without configuring it
 * would believe email works); derived ones cannot.
 *
 * Only two things are stored, in Organization.onboarding:
 * manual completions (for the one item with no system trace,
 * reading the admin guide) and per-item "dismiss forever"
 * choices. State is org-scoped, not per-admin: these are org
 * setup tasks, and once anyone has done or dismissed one it
 * should stop nagging every admin.
 */

export const ONBOARDING_KEYS = [
  'configure-email',
  'invite-team',
  'first-map',
  'admin-docs',
] as const;

export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];

/** Items whose done state can only come from an explicit user
 *  action rather than observable system state. */
const MANUAL_KEYS: ReadonlySet<OnboardingKey> = new Set(['admin-docs']);

export interface OnboardingItemStatus {
  key: OnboardingKey;
  kind: 'derived' | 'manual';
  done: boolean;
  dismissed: boolean;
  /** Small facts the UI can surface next to the row (e.g. the
   *  current member count on the invite item). */
  detail: Record<string, number | boolean>;
}

export interface OnboardingStatus {
  items: OnboardingItemStatus[];
  /** Items neither done nor dismissed; the sidebar badge count. */
  openCount: number;
}

interface StoredState {
  completed: string[];
  dismissed: string[];
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  async getStatus(orgId: string): Promise<OnboardingStatus> {
    const [stored, smtp, memberCount, firstMapItem] = await Promise.all([
      this.readStored(orgId),
      this.settings.getSmtpConfig(),
      this.prisma.user.count({ where: { orgId } }),
      this.prisma.item.findFirst({
        where: {
          orgId,
          deletedAt: null,
          OR: [{ type: 'map' }, { seedKind: { startsWith: 'sample:' } }],
        },
        select: { id: true },
      }),
    ]);

    const smtpConfigured =
      smtp !== null && smtp.enabled && smtp.host.length > 0;

    const items: OnboardingItemStatus[] = [
      {
        key: 'configure-email',
        kind: 'derived',
        done: smtpConfigured,
        dismissed: stored.dismissed.includes('configure-email'),
        detail: { smtpEnabled: smtp?.enabled ?? false },
      },
      {
        key: 'invite-team',
        kind: 'derived',
        done: memberCount > 1,
        dismissed: stored.dismissed.includes('invite-team'),
        detail: { memberCount },
      },
      {
        key: 'first-map',
        kind: 'derived',
        done: firstMapItem !== null,
        dismissed: stored.dismissed.includes('first-map'),
        detail: {},
      },
      {
        key: 'admin-docs',
        kind: 'manual',
        done: stored.completed.includes('admin-docs'),
        dismissed: stored.dismissed.includes('admin-docs'),
        detail: {},
      },
    ];

    return {
      items,
      openCount: items.filter((i) => !i.done && !i.dismissed).length,
    };
  }

  async dismiss(orgId: string, key: OnboardingKey): Promise<OnboardingStatus> {
    const stored = await this.readStored(orgId);
    if (!stored.dismissed.includes(key)) {
      stored.dismissed.push(key);
      await this.writeStored(orgId, stored);
    }
    return this.getStatus(orgId);
  }

  /** Manual items only: derived items reach done by the underlying
   *  thing actually happening, and pretending otherwise would leave
   *  the admin believing e.g. email works when it does not. */
  async complete(orgId: string, key: OnboardingKey): Promise<OnboardingStatus> {
    if (!MANUAL_KEYS.has(key)) {
      throw new BadRequestException(
        `"${key}" completes automatically when the underlying setup is done; it cannot be checked off manually. Use dismiss to hide it instead.`,
      );
    }
    const stored = await this.readStored(orgId);
    if (!stored.completed.includes(key)) {
      stored.completed.push(key);
      await this.writeStored(orgId, stored);
    }
    return this.getStatus(orgId);
  }

  /** Undo a dismissal (and, for manual items, a completion). */
  async restore(orgId: string, key: OnboardingKey): Promise<OnboardingStatus> {
    const stored = await this.readStored(orgId);
    const nextDismissed = stored.dismissed.filter((k) => k !== key);
    const nextCompleted = stored.completed.filter((k) => k !== key);
    if (
      nextDismissed.length !== stored.dismissed.length ||
      nextCompleted.length !== stored.completed.length
    ) {
      await this.writeStored(orgId, {
        completed: nextCompleted,
        dismissed: nextDismissed,
      });
    }
    return this.getStatus(orgId);
  }

  assertValidKey(raw: string): OnboardingKey {
    const found = ONBOARDING_KEYS.find((k) => k === raw);
    if (!found) {
      throw new BadRequestException(`Unknown onboarding item "${raw}".`);
    }
    return found;
  }

  private async readStored(orgId: string): Promise<StoredState> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { onboarding: true },
    });
    return parseStored(org.onboarding);
  }

  /**
   * Plain read-modify-write, no transaction: the column holds two
   * short arrays only admins touch, so a lost update in a race
   * between two admins costs at most one re-click, while the
   * alternative (row lock on organization) sits on a hot row every
   * request path joins against.
   */
  private async writeStored(orgId: string, state: StoredState): Promise<void> {
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { onboarding: state as unknown as object },
    });
  }
}

/** Defensive parse: the column defaults to {} and is only ever
 *  written by this service, but a hand-edited row must not be able
 *  to crash every admin page load. */
function parseStored(raw: unknown): StoredState {
  const out: StoredState = { completed: [], dismissed: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  const rec = raw as Record<string, unknown>;
  if (Array.isArray(rec.completed)) {
    out.completed = rec.completed.filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(rec.dismissed)) {
    out.dismissed = rec.dismissed.filter((v): v is string => typeof v === 'string');
  }
  return out;
}
