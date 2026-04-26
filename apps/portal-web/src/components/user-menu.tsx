'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LogOut, UserCircle } from 'lucide-react';
import { EntityBadge } from '@gratis-gis/ui';

interface Props {
  /** Stable id used for the fallback badge color. Email works when the DB id isn't available. */
  seed: string;
  displayName: string;
  orgName: string | null;
  avatarUrl: string | null;
}

/**
 * Click-to-open menu on the top-bar avatar. Sign out must always be one
 * gesture away; burying it behind a Profile page (which relies on API
 * calls that can fail after a session drifts out of sync with Keycloak)
 * was a mistake. Keep this lean: Profile, Sign out, and room to grow.
 */
export function UserMenu({ seed, displayName, orgName, avatarUrl }: Props) {
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
              Profile
            </Link>
            {/* Bulletproof sign-out: explicit window.location.assign
                in an onClick handler, no <Link> or anchor that any
                framework / SW / accessibility-tree shim could
                intercept. The plain-<a> variant we tried first
                still didn't navigate in incognito; this version
                bypasses every link-handling code path. */}
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                // Diagnostic log so we can confirm in the browser
                // console whether the click handler is even firing.
                // If this never logs, the click is being swallowed
                // before reaching React; if it logs but the
                // navigation doesn't happen, something else is
                // stopping window.location.assign.
                // eslint-disable-next-line no-console
                console.log('[sign-out] click fired, navigating');
                window.location.assign('/api/auth/federated-logout');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-danger/5"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
