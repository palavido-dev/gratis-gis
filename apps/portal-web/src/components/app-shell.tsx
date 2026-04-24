import Link from 'next/link';
import type { ReactNode } from 'react';
import { getServerSession } from 'next-auth';
import {
  Archive,
  Compass,
  LayoutGrid,
  Map as MapIcon,
  Paintbrush,
  Sparkles,
  Users,
  Bell,
  Search,
  Shield,
  Trash2,
} from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { UserMenu } from './user-menu';

/**
 * Top-level chrome shared by every portal page: top bar with brand + search
 * + account, left nav with primary destinations, and a content area. One
 * consistent frame keeps the app feeling cohesive as we add surfaces.
 */
type Me = {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  orgName: string | null;
  /** Role derived from the JWT's org_role claim. Used to gate the
   *  Admin section in the sidebar so non-admins never see it. */
  orgRole: 'viewer' | 'contributor' | 'admin';
};

export async function AppShell({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);

  // Fetch the user's profile so we can show their avatar + org in the
  // top bar. Silently fall back if this fails so the shell still renders
  // (e.g. the user is signed out and the fetch 401s).
  let me: Me | null = null;
  if (session) {
    try {
      me = await apiFetch<Me>('/api/users/me');
    } catch {
      me = null;
    }
  }

  // Unauthenticated visitors get no chrome — the page they land on
  // (the public landing at /, the /signed-out screen, etc.) is
  // responsible for its own layout. Prevents the sidebar / nav from
  // showing links the user can't use without signing in.
  if (!session) {
    return (
      <div className="min-h-screen bg-surface-0 text-ink-0">{children}</div>
    );
  }

  return (
    <div className="flex min-h-screen bg-surface-0 text-ink-0">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface-1 px-3 py-4 md:block">
        <Link href="/" className="flex items-center gap-2 px-2 py-2">
          <Compass className="h-6 w-6 text-accent" />
          <span className="text-base font-semibold tracking-tight">GratisGIS</span>
        </Link>
        <nav className="mt-4 flex flex-col gap-0.5 text-sm">
          <NavLink href="/" icon={<LayoutGrid className="h-4 w-4" />}>Overview</NavLink>
          {/* Single items entry. The My / All toggle lives on the page
              itself — see apps/portal-web/src/app/items/page.tsx. */}
          <NavLink href="/items" icon={<MapIcon className="h-4 w-4" />}>Items</NavLink>
          <NavLink href="/groups" icon={<Users className="h-4 w-4" />}>Groups</NavLink>
          <NavLink href="/recently-deleted" icon={<Trash2 className="h-4 w-4" />}>
            Recently deleted
          </NavLink>
          {me?.orgRole === 'admin' ? (
            <>
              <p className="mt-4 px-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Admin
              </p>
              <NavLink
                href="/admin/users"
                icon={<Shield className="h-4 w-4" />}
              >
                Users
              </NavLink>
              <NavLink
                href="/admin/branding"
                icon={<Paintbrush className="h-4 w-4" />}
              >
                Landing page
              </NavLink>
              <NavLink
                href="/admin/backup"
                icon={<Archive className="h-4 w-4" />}
              >
                Backup
              </NavLink>
              <NavLink
                href="/admin/housekeeping"
                icon={<Sparkles className="h-4 w-4" />}
              >
                Housekeeping
              </NavLink>
            </>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-surface-0/80 px-4 backdrop-blur">
          <div className="flex flex-1 items-center gap-3">
            <label className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                placeholder="Search items, groups, people…"
                className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm text-ink-1 placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
            </button>
            {session ? (
              <UserMenu
                seed={me?.id ?? session.user?.email ?? 'you'}
                displayName={me?.fullName ?? session.user?.name ?? 'You'}
                orgName={me?.orgName ?? null}
                avatarUrl={me?.avatarUrl ?? null}
              />
            ) : (
              <Link
                href="/api/auth/signin"
                className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
              >
                Sign in
              </Link>
            )}
          </div>
        </header>

        <main className="flex-1 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-ink-1 transition-colors hover:bg-surface-2"
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Link>
  );
}
