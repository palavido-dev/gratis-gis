// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Global help drawer (#118).  Two modes:
 *
 * 1. **Browse / search**: opens with a search box focused, lets
 *    the user type to find a doc, click through to read.
 *
 * 2. **Pick-a-control**: after the user toggles "what is this?"
 *    mode, the next click on any element with a `data-help`
 *    attribute opens the doc whose frontmatter `controls` list
 *    claims that id.  Falls back to a friendly "no doc for this
 *    control yet" message when the binding doesn't resolve.
 *
 * Renders as a slide-in panel from the right edge, doesn't lock
 * body scroll (so the user can still drag the map underneath).
 * Closes on Escape / backdrop click.
 *
 * Doc bodies are fetched lazily via a small JSON endpoint
 * (/help/api/doc?slug=...) so we don't bake every doc into the
 * shell's JS bundle.  Search index is pre-baked at build time
 * via the Help route's server component, but the drawer fetches
 * a slim variant via /help/api/index for portability.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { HelpCircle, Search, Target, X } from 'lucide-react';

interface HelpIndexEntry {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  controls: string[];
  haystack: string;
}

interface DrawerState {
  open: boolean;
  /** Slug currently displayed in the drawer; null = search view. */
  slug: string | null;
  /** Pick-a-control mode: next click on a `data-help` element
   *  opens its doc. */
  picking: boolean;
}

interface HelpDrawerContextValue {
  open: () => void;
  openSlug: (slug: string) => void;
  togglePicking: () => void;
  close: () => void;
  state: DrawerState;
}

const HelpDrawerContext = createContext<HelpDrawerContextValue | null>(null);

export function useHelpDrawer(): HelpDrawerContextValue {
  const ctx = useContext(HelpDrawerContext);
  if (!ctx) throw new Error('useHelpDrawer outside provider');
  return ctx;
}

export function HelpDrawerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DrawerState>({
    open: false,
    slug: null,
    picking: false,
  });
  const [index, setIndex] = useState<HelpIndexEntry[] | null>(null);
  const [doc, setDoc] = useState<{
    slug: string;
    title: string;
    summary: string;
    html: string;
  } | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Lazy-load the search index the first time the drawer opens.
  // Subsequent opens reuse the cached array.
  useEffect(() => {
    if (!state.open || index) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/help/api/index', { cache: 'force-cache' });
        if (!res.ok) return;
        const body = (await res.json()) as HelpIndexEntry[];
        if (!cancelled) setIndex(body);
      } catch {
        /* network or build-time error -- search just stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.open, index]);

  // Lazy-fetch the rendered doc when slug changes.
  useEffect(() => {
    if (!state.slug) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/help/api/doc?slug=${encodeURIComponent(state.slug!)}`,
          { cache: 'force-cache' },
        );
        if (!res.ok) {
          if (!cancelled) {
            setDocError(`Couldn't load that page (${res.status}).`);
            setDocLoading(false);
          }
          return;
        }
        const body = (await res.json()) as {
          slug: string;
          title: string;
          summary: string;
          html: string;
        };
        if (!cancelled) {
          setDoc(body);
          setDocLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setDocError(err instanceof Error ? err.message : String(err));
          setDocLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.slug]);

  // Global keyboard shortcut: "?" opens the drawer with search
  // focused.  Doesn't fire when the user is typing in a form
  // input.  Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
      if (e.key === '?' && !editable && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setState((s) => ({ open: true, slug: null, picking: false }));
      }
      if (e.key === 'Escape') {
        setState((s) => (s.open ? { ...s, open: false, picking: false } : s));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pick-a-control mode: capture the next click anywhere in the
  // document, look up the closest [data-help] ancestor, and open
  // the corresponding doc.  `capture` phase so we beat normal
  // click handlers; preventDefault stops the underlying action.
  useEffect(() => {
    if (!state.picking) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const tagged = target?.closest?.('[data-help]');
      const helpId = tagged?.getAttribute('data-help') ?? null;
      e.preventDefault();
      e.stopPropagation();
      if (!helpId) {
        setState((s) => ({ ...s, picking: false }));
        return;
      }
      // Resolve helpId via the index -- the doc that lists this
      // control in its frontmatter `controls` array wins.  Falls
      // back to using helpId as a slug.
      const match = index?.find((d) => d.controls.includes(helpId));
      const slug = match?.slug ?? helpId;
      setState({ open: true, slug, picking: false });
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, [state.picking, index]);

  const ctx = useMemo<HelpDrawerContextValue>(
    () => ({
      open: () => setState({ open: true, slug: null, picking: false }),
      openSlug: (slug) => setState({ open: true, slug, picking: false }),
      togglePicking: () =>
        setState((s) => ({
          open: true,
          slug: null,
          picking: !s.picking,
        })),
      close: () => setState({ open: false, slug: null, picking: false }),
      state,
    }),
    [state],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !index) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ doc: HelpIndexEntry; score: number }> = [];
    for (const doc of index) {
      let score = 0;
      for (const t of terms) {
        if (doc.title.toLowerCase().includes(t)) score += 5;
        if (doc.summary.toLowerCase().includes(t)) score += 2;
        if (doc.haystack.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10);
  }, [query, index]);

  return (
    <HelpDrawerContext.Provider value={ctx}>
      {children}
      {state.open ? (
        <DrawerUI
          state={state}
          query={query}
          setQuery={setQuery}
          results={filtered}
          doc={doc}
          docLoading={docLoading}
          docError={docError}
          openSlug={(slug) => setState({ open: true, slug, picking: false })}
          back={() => setState((s) => ({ ...s, slug: null }))}
          close={() => setState({ open: false, slug: null, picking: false })}
          togglePicking={() =>
            setState((s) => ({ ...s, picking: !s.picking, slug: null }))
          }
        />
      ) : null}
    </HelpDrawerContext.Provider>
  );
}

function DrawerUI({
  state,
  query,
  setQuery,
  results,
  doc,
  docLoading,
  docError,
  openSlug,
  back,
  close,
  togglePicking,
}: {
  state: DrawerState;
  query: string;
  setQuery: (v: string) => void;
  results: Array<{ doc: HelpIndexEntry; score: number }>;
  doc: {
    slug: string;
    title: string;
    summary: string;
    html: string;
  } | null;
  docLoading: boolean;
  docError: string | null;
  openSlug: (slug: string) => void;
  back: () => void;
  close: () => void;
  togglePicking: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus the search box when the drawer opens in search mode.
  useEffect(() => {
    if (!state.slug && inputRef.current) inputRef.current.focus();
  }, [state.slug]);
  return (
    <div
      // No backdrop -- the user can still interact with the page
      // (esp. the map) while the drawer is open.  Picking mode
      // re-adds a transparent capture overlay via the body-level
      // click listener.
      className="fixed right-0 top-0 z-[200] flex h-screen w-full max-w-md flex-col border-l border-border bg-surface-0 shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <HelpCircle className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-ink-0">Help</h2>
        <button
          type="button"
          onClick={togglePicking}
          title={
            state.picking
              ? 'Cancel pick-a-control'
              : 'Pick a control on the page to open its help'
          }
          className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
            state.picking
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
          }`}
        >
          <Target className="h-3 w-3" />
          {state.picking ? 'Cancel' : 'What is this?'}
        </button>
        <Link
          href="/help"
          onClick={close}
          className="inline-flex h-6 items-center rounded border border-border bg-surface-1 px-1.5 text-[11px] font-medium text-ink-1 hover:bg-surface-2"
          title="Open full help in a new page"
        >
          Open full
        </Link>
        <button
          type="button"
          onClick={close}
          aria-label="Close help"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {state.picking ? (
        <div className="border-b border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          Click any control on the page to open its help.  Press Cancel
          (or Escape) to back out.
        </div>
      ) : null}
      {state.slug ? (
        <div className="flex-1 overflow-y-auto">
          <div className="border-b border-border bg-surface-1 px-3 py-2">
            <button
              type="button"
              onClick={back}
              className="text-[11px] text-accent hover:underline"
            >
              ← Back to search
            </button>
          </div>
          {docLoading ? (
            <p className="px-3 py-4 text-xs text-muted">Loading…</p>
          ) : docError ? (
            <p className="px-3 py-4 text-xs text-danger">{docError}</p>
          ) : doc ? (
            <article className="px-4 py-3">
              <h3 className="mb-1 text-base font-semibold text-ink-0">
                {doc.title}
              </h3>
              <p className="mb-3 text-xs text-muted">{doc.summary}</p>
              <div
                className="prose prose-sm text-sm text-ink-1 [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.95em] [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-ink-0 [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-ink-0 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:my-2 [&_pre]:rounded [&_pre]:bg-surface-2 [&_pre]:p-2 [&_pre]:text-[11px] [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1 [&_td]:text-xs [&_th]:border [&_th]:border-border [&_th]:bg-surface-1 [&_th]:p-1 [&_th]:text-left [&_th]:text-xs [&_ul]:my-2 [&_ul]:ml-5 [&_ul]:list-disc"
                dangerouslySetInnerHTML={{ __html: doc.html }}
              />
            </article>
          ) : null}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="border-b border-border bg-surface-1 px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search help…"
                className="w-full rounded-md border border-border bg-surface-0 py-1.5 pl-7 pr-2 text-xs text-ink-0 placeholder-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
          </div>
          {query.trim().length < 2 ? (
            <p className="px-3 py-4 text-xs text-muted">
              Type to search the help system, or press <kbd>?</kbd>{' '}
              anywhere in the portal to open this drawer.  Toggle{' '}
              <strong>What is this?</strong> at the top right and click
              any control to jump to its help.
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted">No matches.</p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map(({ doc }) => (
                <li key={doc.slug}>
                  <button
                    type="button"
                    onClick={() => openSlug(doc.slug)}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <div className="text-xs font-medium text-ink-0">
                      {doc.title}
                    </div>
                    <div className="line-clamp-2 text-[10px] text-muted">
                      {doc.summary}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
