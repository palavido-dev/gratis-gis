// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Activity,
  Archive,
  ArrowRightLeft,
  Bot,
  KeyRound,
  LifeBuoy,
  ListChecks,
  ListTodo,
  Mail,
  MessageSquarePlus,
  Paintbrush,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Smartphone,
  Sparkles,
  UserCog,
  MapPinned,
} from 'lucide-react';

import {
  ADMIN_GROUPS,
  searchSections,
  visibleSections,
  type AdminSection,
} from '@/lib/admin-sections';
import { useT } from '@/lib/i18n/locale-context';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  users: UserCog,
  sharing: ListChecks,
  audit: ScrollText,
  signIn: KeyRound,
  landing: Paintbrush,
  ai: Bot,
  feedback: MessageSquarePlus,
  jobs: ListTodo,
  fieldQueues: Smartphone,
  cleanup: Sparkles,
  agoImport: ArrowRightLeft,
  health: Activity,
  backup: Archive,
  updates: RefreshCw,
  email: Mail,
  geocoding: MapPinned,
  support: LifeBuoy,
};

export function AdminHome({ operator }: { operator: boolean }) {
  const t = useT();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [openSteps, setOpenSteps] = useState<number | null>(null);

  // Open items on the setup checklist. Same call the sidebar used to
  // make for its Getting started link; a failure just hides the card.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/portal/admin/onboarding');
        if (!res.ok) return;
        const body = (await res.json()) as { openCount: number };
        if (!cancelled) setOpenSteps(body.openCount);
      } catch {
        /* the card stays hidden */
      }
    }
    void load();
    window.addEventListener('gg:onboarding-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('gg:onboarding-changed', load);
    };
  }, []);

  const sections = useMemo(() => visibleSections(operator), [operator]);
  const title = (s: AdminSection) => t(`adminHome.cards.${s.id}.title`);
  const desc = (s: AdminSection) => t(`adminHome.cards.${s.id}.desc`);
  const matches = searchSections(sections, query, (s) => `${title(s)} ${desc(s)}`);
  const searching = query.trim() !== '';

  return (
    <div className="w-full pb-10 pt-4">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('adminHome.title')}</h1>
        <p className="mt-0.5 text-sm text-muted">{t('adminHome.intro')}</p>
      </header>

      <label className="relative mb-8 block max-w-xl">
        <span className="sr-only">{t('adminHome.searchLabel')}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter opens the page when the search has narrowed to one.
            if (e.key === 'Enter' && matches.length === 1) router.push(matches[0]!.href);
          }}
          placeholder={t('adminHome.searchPlaceholder')}
          className="h-10 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm shadow-card focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </label>

      {!searching && openSteps !== null && openSteps > 0 ? (
        <Link
          href="/admin/getting-started"
          className="mb-8 flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-4 transition-colors hover:bg-accent/10"
        >
          <Rocket className="mt-0.5 h-5 w-5 text-accent" />
          <span>
            <span className="block font-medium text-ink-0">
              {t('adminHome.gettingStartedTitle')}
            </span>
            <span className="mt-0.5 block text-sm text-ink-1">
              {t('adminHome.gettingStartedDesc', { count: openSteps })}
            </span>
          </span>
        </Link>
      ) : null}

      {matches.length === 0 ? (
        <p className="text-sm text-muted">{t('adminHome.noMatch', { query: query.trim() })}</p>
      ) : (
        ADMIN_GROUPS.map((group) => {
          const cards = matches.filter((s) => s.group === group);
          if (cards.length === 0) return null;
          return (
            <section key={group} id={group} className="mb-8" aria-labelledby={`admin-group-${group}`}>
              <h2
                id={`admin-group-${group}`}
                className="mb-3 text-xs font-medium uppercase tracking-wide text-muted"
              >
                {t(`adminHome.groups.${group}`)}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {cards.map((s) => {
                  const Icon = ICONS[s.id] ?? ListChecks;
                  return (
                    <li key={s.id}>
                      <Link
                        href={s.href}
                        className="flex h-full items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card transition-colors hover:bg-surface-2"
                      >
                        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 font-medium text-ink-0">
                            {title(s)}
                            {s.operatorOnly ? (
                              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-muted">
                                {t('adminHome.operatorBadge')}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-sm text-ink-1">{desc(s)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      {!operator && !searching ? (
        <p className="mt-2 text-xs text-muted">{t('adminHome.operatorNote')}</p>
      ) : null}
    </div>
  );
}
