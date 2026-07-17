// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Client-side help search.  Pure substring scoring over a small
 * index the server passes down: titles + summaries + headings +
 * control labels.  Good enough for the ~100 doc corpus we expect;
 * a future revision can swap in FlexSearch or wire semantic
 * embeddings for the LLM-helper integration.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

interface IndexEntry {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  controls: string[];
  haystack: string;
}

export function HelpSearchBox({ index }: { index: IndexEntry[] }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ doc: IndexEntry; score: number }> = [];
    for (const doc of index) {
      let score = 0;
      for (const t of terms) {
        if (doc.title.toLowerCase().includes(t)) score += 5;
        if (doc.summary.toLowerCase().includes(t)) score += 2;
        if (doc.controls.some((c) => c.toLowerCase().includes(t)))
          score += 4;
        if (doc.haystack.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8);
  }, [query, index]);
  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help…"
          className="w-full rounded-md border border-border bg-surface-1 py-1.5 pl-7 pr-2 text-xs text-ink-0 placeholder-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
      {results.length > 0 ? (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-surface-0 py-1 text-xs shadow-lg">
          {results.map(({ doc }) => (
            <li key={doc.slug}>
              <Link
                href={`/help/${doc.slug}`}
                onClick={() => setQuery('')}
                className="block px-3 py-1.5 hover:bg-surface-2"
              >
                <div className="font-medium text-ink-0">{doc.title}</div>
                <div className="line-clamp-2 text-2xs text-muted">
                  {doc.summary}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
