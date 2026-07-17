// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Recursive sidebar navigation for the help system.  Categories
 * are collapsible (default open if the active doc lives inside);
 * leaves are links.  Pure client component so collapse state
 * doesn't round-trip to the server on every interaction.
 */
import Link from 'next/link';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface NavNode {
  label: string;
  slug?: string;
  children: NavNode[];
}

export function HelpSidebarNav({
  nav,
  activeSlug,
}: {
  nav: NavNode;
  activeSlug: string;
}) {
  return (
    <ul className="space-y-0.5 text-xs">
      {nav.children.map((c, i) => (
        <NavRow
          key={`${c.label}-${i}`}
          node={c}
          activeSlug={activeSlug}
          depth={0}
        />
      ))}
    </ul>
  );
}

function NavRow({
  node,
  activeSlug,
  depth,
}: {
  node: NavNode;
  activeSlug: string;
  depth: number;
}) {
  const isLeaf = !!node.slug;
  // Auto-open categories that contain the active doc.  Walks
  // children recursively; cheap because the tree is tiny.
  const containsActive = containsSlug(node, activeSlug);
  const [open, setOpen] = useState<boolean>(containsActive || depth === 0);
  const isActive = isLeaf && node.slug === activeSlug;
  // Leaves are indented under their category; categories sit
  // flush left so the section breaks read like a real outline.
  const leafIndent = Math.max(0, depth - 1) * 10 + 12;
  if (isLeaf) {
    return (
      <li>
        <Link
          href={`/help/${node.slug}`}
          className={`block border-l-2 py-1 pr-2 text-xs ${
            isActive
              ? 'border-accent bg-accent/10 font-medium text-accent'
              : 'border-transparent text-ink-1 hover:border-border hover:bg-surface-2'
          }`}
          style={{ paddingLeft: `${leafIndent}px` }}
        >
          {node.label}
        </Link>
      </li>
    );
  }
  // Top-level categories render as ALL-CAPS section headers (the
  // outline look authors recognize from real docs sites).  Nested
  // categories (depth >= 1) get a lighter treatment so the eye
  // sees the hierarchy without confusing them with leaves.
  const isTopCategory = depth === 0;
  return (
    <li className={isTopCategory ? 'mt-3 first:mt-0' : 'mt-1'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          isTopCategory
            ? 'flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-2xs font-semibold uppercase tracking-wider text-muted hover:bg-surface-2'
            : 'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-2xs font-medium text-ink-0 hover:bg-surface-2'
        }
        style={{
          paddingLeft: isTopCategory ? '6px' : `${Math.max(0, depth - 1) * 10 + 6}px`,
        }}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted" />
        )}
        <span>{node.label}</span>
      </button>
      {open && node.children.length > 0 ? (
        <ul className="mt-0.5">
          {node.children.map((c, i) => (
            <NavRow
              key={`${c.label}-${i}`}
              node={c}
              activeSlug={activeSlug}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function containsSlug(node: NavNode, slug: string): boolean {
  if (node.slug === slug) return true;
  for (const c of node.children) {
    if (containsSlug(c, slug)) return true;
  }
  return false;
}
