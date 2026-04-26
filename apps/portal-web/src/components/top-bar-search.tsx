'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';

/**
 * Top-bar global search. Lives in the app shell so every page has
 * the same search affordance.
 *
 * Today: typing + pressing Enter navigates to
 * /items?scope=all&q=<query> and leans on the items list's
 * existing server-side search (title + description + tags). The
 * dropdown-style unified search (items / groups / people in one
 * autocomplete) is a worthwhile follow-up but a much bigger UX
 * commitment; we ship the obvious useful behaviour first.
 *
 * Why scope=all by default: AGO's trap is that search defaults to
 * "my items" and people get confused when something they know
 * exists doesn't show up. Defaulting to all items means the
 * search behaves like the user expects ("find anything I can
 * see"); narrowing to "My items" is one click away on the items
 * page itself.
 *
 * Pre-fill: when the user is already on /items with a ?q= param,
 * the input mirrors it so the search isn't lost on subsequent
 * page renders. The mirror runs once per pathname change, not on
 * every keystroke, so the user can keep typing freely.
 */
export function TopBarSearch() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params?.get('q') ?? '';
  const [draft, setDraft] = useState(initial);

  // Re-sync the input when the URL's ?q= changes from outside
  // (e.g. navigation, browser back). Without this the input would
  // hold a stale value after a back-button hit.
  useEffect(() => {
    setDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = draft.trim();
    if (q.length === 0) {
      // Empty submit clears the search. Stay on whatever scope
      // the items page would otherwise show (don't force-flip
      // to All when the user just cleared the query).
      router.push('/items');
      return;
    }
    router.push(
      `/items?scope=all&q=${encodeURIComponent(q)}`,
    );
  }

  return (
    <form onSubmit={submit} className="relative max-w-md flex-1" role="search">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search items..."
        aria-label="Search items"
        className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm text-ink-1 placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
    </form>
  );
}
