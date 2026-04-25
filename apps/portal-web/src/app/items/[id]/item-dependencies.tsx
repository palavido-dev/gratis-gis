'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  HelpCircle,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { ItemAccess, ItemType } from '@gratis-gis/shared-types';
import { getItemTypeIcon, getItemTypeAccent } from '@/lib/item-type-icon';

/**
 * Item dependency panel shown on the detail page. Two lists:
 *
 *   - Used by: items that reference THIS one. Toggle "Transitive"
 *     to include indirect dependents (a layer used by a map used
 *     by a dashboard: the dashboard shows up too).
 *   - Depends on: items that THIS one references (e.g. the feature
 *     services powering each of a map's layers).
 *
 * Data comes from portal-api:
 *   GET /api/items/:id/dependents?transitive=true
 *   GET /api/items/:id/dependencies
 *
 * Backend visibility filter is already applied, so anything a user
 * can't see elsewhere won't appear here either.
 */
interface Row {
  id: string;
  type: ItemType;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  updatedAt: string;
  access: ItemAccess;
}

interface Props {
  itemId: string;
}

export function ItemDependencies({ itemId }: Props) {
  const [transitive, setTransitive] = useState(true);
  const [dependents, setDependents] = useState<Row[] | null>(null);
  const [dependencies, setDependencies] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [upRes, downRes] = await Promise.all([
        fetch(
          `/api/portal/items/${itemId}/dependents?transitive=${transitive ? 'true' : 'false'}`,
        ),
        fetch(`/api/portal/items/${itemId}/dependencies`),
      ]);
      // Include the response body in error messages so the UI actually
      // says why it failed instead of just echoing a status code.
      if (!upRes.ok) {
        const text = await upRes.text().catch(() => '');
        throw new Error(
          `Used-by query failed (${upRes.status}): ${text || upRes.statusText || 'no body'}`,
        );
      }
      if (!downRes.ok) {
        const text = await downRes.text().catch(() => '');
        throw new Error(
          `Depends-on query failed (${downRes.status}): ${text || downRes.statusText || 'no body'}`,
        );
      }
      setDependents((await upRes.json()) as Row[]);
      setDependencies((await downRes.json()) as Row[]);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load dependency data');
    } finally {
      setLoading(false);
    }
  }, [itemId, transitive]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border border-border bg-surface-1">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink-0">
            Related items
          </h2>
          <p className="text-xs text-muted">
            Other content that uses this item or that this item uses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted"
            title={
              'When on, this walks the full chain of references. ' +
              'Example: a feature layer is used by a web map, which is ' +
              'used by an app: all of those show up. When off, only ' +
              'items that reference this one directly appear.'
            }
          >
            <input
              type="checkbox"
              checked={transitive}
              onChange={(e) => setTransitive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border"
            />
            Include indirect
            <HelpCircle className="h-3 w-3 text-muted" />
          </label>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-1.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <p className="px-3 py-3 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-0 md:grid-cols-2 md:divide-x md:divide-border">
        <DependencyList
          title="Used by"
          help={
            transitive
              ? 'Every item that references this one: directly, or through a chain of other items.'
              : 'Items that reference this one directly.'
          }
          icon={<ArrowUpRight className="h-3.5 w-3.5" />}
          rows={dependents}
          loading={loading}
          emptyMessage={
            transitive
              ? 'No other items reference this one.'
              : 'No other items reference this one directly.'
          }
        />
        <DependencyList
          title="Depends on"
          help="Items that this one references (e.g. feature services powering web map layers)."
          icon={<ArrowDownRight className="h-3.5 w-3.5" />}
          rows={dependencies}
          loading={loading}
          emptyMessage="This item doesn't reference any other items."
        />
      </div>
    </section>
  );
}

interface DependencyListProps {
  title: string;
  help: string;
  icon: React.ReactNode;
  rows: Row[] | null;
  loading: boolean;
  emptyMessage: string;
}

function DependencyList({
  title,
  help,
  icon,
  rows,
  loading,
  emptyMessage,
}: DependencyListProps) {
  return (
    <div className="px-3 py-3">
      <div className="mb-2 flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-2 text-muted">
          {icon}
        </span>
        <div>
          <p className="text-xs font-semibold text-ink-0">{title}</p>
          <p className="text-[11px] text-muted">{help}</p>
        </div>
      </div>

      {rows === null && loading ? (
        <p className="px-2 py-3 text-[11px] text-muted">Loading…</p>
      ) : rows && rows.length > 0 ? (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/items/${r.id}`}
                className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
              >
                <span
                  className={`${getItemTypeAccent(r.type)} shrink-0`}
                  aria-hidden="true"
                >
                  <TypeIcon type={r.type} />
                </span>
                <span className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-ink-0">
                    {r.title}
                  </p>
                  <p className="truncate text-[10px] uppercase tracking-wide text-muted">
                    {r.type.replace(/_/g, ' ')}
                  </p>
                </span>
                <ChevronDown className="h-3 w-3 -rotate-90 shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-3 text-[11px] text-muted">{emptyMessage}</p>
      )}
    </div>
  );
}

function TypeIcon({ type }: { type: ItemType }) {
  const Icon = getItemTypeIcon(type);
  return <Icon className="h-3.5 w-3.5" />;
}
