// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { TabPanel, TabStrip } from '@/components/ui/tab-strip';

/**
 * Generic hash-synced tab shell (#75), the reusable core of the
 * pattern the item detail page introduced (see item-tabs.tsx, which
 * keeps its own copy because of its children-as-Overview quirk and
 * its legacy `#sharing` alias).
 *
 * Content is passed as already-rendered nodes so a server component
 * page can build the panels with its server-side fetches and hand
 * them across the client boundary; the shell only owns which panel
 * is visible. Panels are hidden rather than unmounted so client
 * state inside a panel (selections, dialogs, in-flight actions)
 * survives a look at another tab.
 */

export interface HashTabSpec {
  id: string;
  label: string;
  content: React.ReactNode;
}

export function HashTabs({
  tabs,
  ariaLabel,
  idPrefix,
}: {
  tabs: HashTabSpec[];
  ariaLabel: string;
  /** Stable prefix for the tab/panel DOM ids, e.g. "housekeeping". */
  idPrefix: string;
}) {
  // Server renders the first tab. The hash is read after mount
  // instead of during render because the server cannot see it, and
  // initialising from it here would be a hydration mismatch.
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    const apply = () => {
      const raw = window.location.hash.replace(/^#/, '');
      if (raw && ids.has(raw)) setActive(raw);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
    // Tab ids are stable for a given page; re-running on every render
    // of the parent would fight the user's own tab clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(next: string) {
    setActive(next);
    // replaceState, not a hash assignment: assigning to
    // location.hash pushes a history entry per tab click, so Back
    // walks the user through their own tab browsing instead of
    // returning them to the previous page.
    window.history.replaceState(null, '', `#${next}`);
  }

  return (
    <div>
      <TabStrip
        tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
        value={active}
        onChange={select}
        ariaLabel={ariaLabel}
        idPrefix={idPrefix}
        variant="inline"
        className="mb-5 border-b border-border"
      />
      {tabs.map((t) => (
        <TabPanel
          key={t.id}
          tab={t.id}
          active={active}
          idPrefix={idPrefix}
          mode="hidden"
        >
          {t.content}
        </TabPanel>
      ))}
    </div>
  );
}
