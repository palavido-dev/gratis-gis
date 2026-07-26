// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { LogOut, UserCircle } from 'lucide-react';
import { EntityBadge } from '@gratis-gis/ui';

import { useT } from '@/lib/i18n/locale-context';
import { LocaleSwitcher } from './locale-switcher';
import { ThemeSwitcher } from './theme-switcher';

interface Props {
  /** Stable id used for the fallback badge color. Email works when the DB id isn't available. */
  seed: string;
  displayName: string;
  orgName: string | null;
  avatarUrl: string | null;
}

/**
 * Ask the active service worker to drop the runtime caches that hold
 * auth-gated portal responses (vector tiles and geojson fallbacks).
 * Without this, org data cached during a session stays readable by
 * the next person on a shared machine even after sign-out. Resolves
 * on the worker's ack, or after a short timeout so an absent or
 * wedged worker (dev mode has none) can never block sign-out.
 */
async function clearUserCaches(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  // getRegistration() resolves immediately with undefined when no
  // worker is registered; navigator.serviceWorker.ready would hang
  // forever in that case.
  const reg = await navigator.serviceWorker
    .getRegistration()
    .catch(() => undefined);
  const worker = reg?.active;
  if (!worker) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    setTimeout(resolve, 2_000);
    worker.postMessage({ type: 'gg:clear-user-caches' }, [channel.port2]);
  });
}

/**
 * The complete sign-out flow, shared by every surface that offers a
 * Sign out action (this menu, the profile page, the route error
 * screen). Order matters:
 *
 *   1. Clear the service worker's per-user runtime caches so cached
 *      org data doesn't outlive the session on a shared machine.
 *   2. NextAuth's client signOut() with redirect:false, so the
 *      session cookies are cleared by NextAuth's own runtime
 *      (matching the exact name + attributes it used at sign-in).
 *      Clearing them from a sibling route was too fragile:
 *      name/attribute drift between the set and the clear left the
 *      session token in place.
 *   3. Navigate to /api/auth/federated-logout, which redirects
 *      through Keycloak's end-session endpoint so the IDP-side SSO
 *      session dies too.
 *
 * Callers must NOT link straight to /api/auth/federated-logout:
 * that route no longer clears the NextAuth cookie itself, so a bare
 * link leaves the local session alive.
 *
 * #249.17: when signing out from inside the field PWA (/field or
 * /field/<id>), Keycloak's post-logout redirect returns to /field.
 * The unauthenticated /field load then routes through middleware ->
 * /signin?callbackUrl=/field -> Keycloak login -> /field, keeping a
 * mobile field user in the field sandbox through a sign-out +
 * sign-in cycle. Other sign-outs return to the landing page.
 */
export async function federatedSignOut(): Promise<void> {
  await clearUserCaches();
  try {
    // redirect: false so we control the navigation; signOut posts
    // to /api/auth/signout and lets NextAuth's own cookie config
    // do the clearing.
    await signOut({ redirect: false });
  } catch {
    // signOut errors are non-blocking; the worst case is a stale
    // cookie that the server-side ItemsService will reject on the
    // next API call. Still navigate to federated-logout so
    // Keycloak's SSO is killed.
  }
  const onFieldRoute =
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/field');
  const target = onFieldRoute
    ? '/api/auth/federated-logout?redirect=/field'
    : '/api/auth/federated-logout';
  window.location.assign(target);
}

/**
 * Sign-out button for server-component surfaces (e.g. the profile
 * page) that can't attach a click handler themselves. Runs the same
 * shared federatedSignOut flow as the user menu. Styling is the
 * caller's: pass className + children so the button matches its
 * surroundings.
 */
export function SignOutButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => void federatedSignOut()}
    >
      {children}
    </button>
  );
}

/**
 * Click-to-open menu on the top-bar avatar. Sign out must always be one
 * gesture away; burying it behind a Profile page (which relies on API
 * calls that can fail after a session drifts out of sync with Keycloak)
 * was a mistake. Keep this lean: Profile, Sign out, and room to grow.
 */
export function UserMenu({ seed, displayName, orgName, avatarUrl }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click and Escape so the menu feels native.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
      >
        <EntityBadge
          label={displayName}
          seed={seed}
          imageUrl={avatarUrl}
          size="sm"
          rounded="full"
        />
        <span className="hidden md:flex md:flex-col md:items-start md:leading-tight">
          <span className="text-ink-1">{displayName}</span>
          {orgName ? (
            <span className="text-xs text-muted">{orgName}</span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-md border border-border bg-surface-1 shadow-raised"
        >
          <div className="border-b border-border px-3 py-2">
            <div className="truncate text-sm font-medium text-ink-0">
              {displayName}
            </div>
            {orgName ? (
              <div className="truncate text-xs text-muted">{orgName}</div>
            ) : null}
          </div>
          <div className="py-1">
            <Link
              role="menuitem"
              href="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-ink-1 hover:bg-surface-2"
            >
              <UserCircle className="h-4 w-4 text-muted" />
              {t('nav.profile')}
            </Link>
            <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
              <LocaleSwitcher />
              <ThemeSwitcher />
            </div>
            {/* Sign out runs the shared federatedSignOut flow
                (cache purge, NextAuth cookie clear, Keycloak
                end-session hop). See its doc comment above for
                the ordering rationale. */}
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                void federatedSignOut();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-danger/5"
            >
              <LogOut className="h-4 w-4" />
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
