// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { TabPanel, TabStrip } from '@/components/ui/tab-strip';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Tabbed body for the item detail page.
 *
 * The page used to be one long column: the type's own editor, then
 * dependencies, then sharing. On a data_layer that put the sharing
 * panel below a map preview, a stats strip, a provenance panel, a
 * schema inspector, a version history and a multi-layer schema
 * builder, so "who can see this?" was a scroll of several screens
 * from the answer.
 *
 * Content is passed in as already-rendered nodes rather than as
 * component references, because the page is a server component and
 * every panel it builds needs the server-side item fetch. Passing
 * elements through a client boundary is what lets the shell stay
 * client-side (it owns the selection) while the panels stay server
 * components.
 *
 * Panels are hidden rather than unmounted. Several of them hold
 * unsaved edits (the schema builder most obviously), and unmounting
 * one to look at a date is indistinguishable from discarding it.
 */

export interface ItemTabSpec {
  id: string;
  label: string;
  content: React.ReactNode;
}

/**
 * Overview is passed as `children` rather than as another entry in
 * `tabs` so the detail page's per-type body can stay exactly where it
 * is in the JSX. That body is a 500-line conditional covering every
 * item type, and hoisting it into a variable to pass as a prop would
 * have made the diff that introduced tabs unreviewable.
 */

/**
 * Hash values that should select a tab other than the one named by
 * the hash itself. `#sharing` predates the tabs and is linked from
 * the folder row menu, the sharing indicator and the paired-layer
 * notice, so it has to keep working; it now resolves to the Access
 * tab, which is where the sharing panel lives.
 */
const HASH_ALIASES: Record<string, string> = {
  sharing: 'access',
};

export function ItemTabs({
  tabs,
  children,
}: {
  tabs: ItemTabSpec[];
  children: React.ReactNode;
}) {
  const t = useT();
  const all: ItemTabSpec[] = [
    { id: 'overview', label: t('itemTabs.overview'), content: children },
    ...tabs,
  ];
  // Server renders the first tab. The hash is read after mount
  // instead of during render because the server cannot see it, and
  // initialising from it here would be a hydration mismatch.
  const [active, setActive] = useState('overview');

  useEffect(() => {
    const ids = new Set(all.map((t) => t.id));
    const apply = (scroll: boolean) => {
      const raw = window.location.hash.replace(/^#/, '');
      if (!raw) return;
      const target = HASH_ALIASES[raw] ?? raw;
      if (!ids.has(target)) return;
      setActive(target);
      if (!scroll) return;
      // The element is display:none until the state above commits, so
      // the browser's own hash scroll has already failed by now.
      window.requestAnimationFrame(() => {
        document
          .getElementById(raw)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    };
    apply(true);
    const onHashChange = () => apply(true);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // Tab ids are stable for a given item; re-running on every render
    // of the parent would fight the user's own tab clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(next: string) {
    setActive(next);
    // replaceState, not a hash assignment: assigning to
    // location.hash pushes a history entry per tab click, so Back
    // walks the user through their own tab browsing instead of
    // returning them to the item list.
    window.history.replaceState(null, '', `#${next}`);
  }

  return (
    <div>
      <TabStrip
        tabs={all.map((t) => ({ id: t.id, label: t.label }))}
        value={active}
        onChange={select}
        ariaLabel={t('itemTabs.sections')}
        idPrefix="item"
        variant="inline"
        className="mb-5 border-b border-border"
      />
      {all.map((t) => (
        <TabPanel
          key={t.id}
          tab={t.id}
          active={active}
          idPrefix="item"
          mode="hidden"
        >
          {t.content}
        </TabPanel>
      ))}
    </div>
  );
}
