// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Admin getting-started checklist (#147 Phase 3). The server page
 * fetches the initial status; every mutation returns the fresh
 * status so this component never guesses. Derived items (email,
 * team, first map) tick themselves when the underlying setup
 * actually happens; the one manual item (the admin guide) is
 * completed by taking its action. Any open item can be hidden
 * forever, and hidden items stay listed at the bottom with a
 * Restore so "forever" is reversible.
 *
 * After every change we broadcast `gg:onboarding-changed` so the
 * sidebar badge (GettingStartedNavLink in app-shell-chrome)
 * refetches without a page reload.
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Circle,
  Loader2,
  Mail,
  Map as MapIcon,
  RotateCcw,
  UserPlus,
} from 'lucide-react';

import { toast } from '@/lib/toast';

export interface OnboardingItem {
  key: 'configure-email' | 'invite-team' | 'first-map' | 'admin-docs';
  kind: 'derived' | 'manual';
  done: boolean;
  dismissed: boolean;
  detail: Record<string, number | boolean>;
}

export interface OnboardingStatus {
  items: OnboardingItem[];
  openCount: number;
}

export const ONBOARDING_CHANGED_EVENT = 'gg:onboarding-changed';

interface RowMeta {
  icon: ReactNode;
  title: string;
  description: (item: OnboardingItem) => string;
  actionLabel: string;
  /** Where the action goes. The admin-docs row also completes
   *  itself on the way out (see onAction below). */
  href: string;
}

const ROW_META: Record<OnboardingItem['key'], RowMeta> = {
  'configure-email': {
    icon: <Mail className="h-4 w-4" />,
    title: 'Set up email',
    description: () =>
      'Connect an SMTP server so invitations, password setup links, and notifications can send. The portal works without it, but invited users will not get their sign-in email.',
    actionLabel: 'Open notification settings',
    href: '/admin/notifications',
  },
  'invite-team': {
    icon: <UserPlus className="h-4 w-4" />,
    title: 'Invite your team',
    description: (item) => {
      const n = typeof item.detail.memberCount === 'number' ? item.detail.memberCount : 1;
      return n > 1
        ? `Add teammates and choose their roles. Your organization has ${n} members.`
        : 'Add teammates and choose their roles: viewers, contributors, or fellow admins.';
    },
    actionLabel: 'Open users',
    href: '/admin/users',
  },
  'first-map': {
    icon: <MapIcon className="h-4 w-4" />,
    title: 'Make your first map',
    description: () =>
      'Create a map or upload data, or load the sample dataset for a ready-made scenario to explore and edit.',
    actionLabel: 'Go to content',
    href: '/items',
  },
  'admin-docs': {
    icon: <BookOpen className="h-4 w-4" />,
    title: 'Skim the admin guide',
    description: () =>
      'The built-in guide covers roles, backups, branding, and housekeeping. Ten minutes now saves surprises later.',
    actionLabel: 'Open the guide',
    href: '/help',
  },
};

export function GettingStartedView({
  initialStatus,
}: {
  initialStatus: OnboardingStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function mutate(key: OnboardingItem['key'], verb: 'dismiss' | 'complete' | 'restore') {
    setBusyKey(`${key}:${verb}`);
    try {
      const res = await fetch(`/api/portal/admin/onboarding/${key}/${verb}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as OnboardingStatus);
      window.dispatchEvent(new CustomEvent(ONBOARDING_CHANGED_EVENT));
    } catch {
      toast.error('Could not update the checklist. Try again.');
    } finally {
      setBusyKey(null);
    }
  }

  /** The guide row completes by being used: mark it read (fire and
   *  wait so the badge is right when the user comes back), then
   *  navigate. Derived rows just navigate. */
  async function onAction(item: OnboardingItem) {
    if (item.kind === 'manual' && !item.done) {
      await mutate(item.key, 'complete');
    }
    router.push(ROW_META[item.key].href);
  }

  const visible = status.items.filter((i) => !i.dismissed);
  const hidden = status.items.filter((i) => i.dismissed);
  const doneCount = status.items.filter((i) => i.done && !i.dismissed).length;
  const allResolved = status.openCount === 0;

  return (
    <div className="flex flex-col gap-4">
      {allResolved ? (
        <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-ink-0">
          <p className="font-medium">You&apos;re all set.</p>
          <p className="mt-0.5 text-muted">
            Every item is done or hidden, so this page has left the
            sidebar. It stays reachable at /admin/getting-started.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {doneCount} of {visible.length} complete. Items check
          themselves off as the underlying setup happens.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {visible.map((item) => {
          const meta = ROW_META[item.key];
          return (
            <li
              key={item.key}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 sm:flex-row sm:items-center"
            >
              <span
                className={
                  item.done
                    ? 'mt-0.5 shrink-0 text-success'
                    : 'mt-0.5 shrink-0 text-muted'
                }
                aria-hidden="true"
              >
                {item.done ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <Circle className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-ink-0">
                  <span className="text-accent">{meta.icon}</span>
                  {meta.title}
                  {item.done ? (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-2xs font-medium text-success">
                      Done
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {meta.description(item)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!item.done ? (
                  <button
                    type="button"
                    onClick={() => mutate(item.key, 'dismiss')}
                    disabled={busyKey !== null}
                    className="rounded-md px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                  >
                    {busyKey === `${item.key}:dismiss` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      'Hide'
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void onAction(item)}
                  disabled={busyKey !== null}
                  className="rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:border-accent hover:bg-accent/5 disabled:opacity-50"
                >
                  {busyKey === `${item.key}:complete` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    meta.actionLabel
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {hidden.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-0 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Hidden items
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {hidden.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between text-sm text-muted"
              >
                <span>{ROW_META[item.key].title}</span>
                <button
                  type="button"
                  onClick={() => mutate(item.key, 'restore')}
                  disabled={busyKey !== null}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-1 transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  {busyKey === `${item.key}:restore` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
