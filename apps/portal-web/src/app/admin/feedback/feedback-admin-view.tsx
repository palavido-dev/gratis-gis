// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Undo2,
} from 'lucide-react';

export type FeedbackStatus = 'new' | 'handled' | 'spam';

export interface FeedbackRow {
  id: string;
  message: string;
  status: FeedbackStatus;
  name: string | null;
  email: string | null;
  pageUrl: string | null;
  appVersion: string | null;
  userAgent: string | null;
  viewport: string | null;
  hasScreenshot: boolean;
  createdAt: string;
  handledAt: string | null;
  user: { id: string; username: string; fullName: string } | null;
  handledBy: { username: string; fullName: string } | null;
}

export interface FeedbackPage {
  items: FeedbackRow[];
  total: number;
  limit: number;
  offset: number;
  counts: Record<FeedbackStatus, number>;
}

const PAGE_SIZE = 25;

const TABS: Array<{ key: FeedbackStatus | 'all'; label: string }> = [
  { key: 'new', label: 'New' },
  { key: 'handled', label: 'Handled' },
  { key: 'spam', label: 'Spam' },
  { key: 'all', label: 'Everything' },
];

export function FeedbackAdminView({ initial }: { initial: FeedbackPage }) {
  const [page, setPage] = useState<FeedbackPage>(initial);
  const [tab, setTab] = useState<FeedbackStatus | 'all'>('new');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextTab: FeedbackStatus | 'all', nextOffset: number) => {
      setError(null);
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(nextOffset),
      });
      if (nextTab !== 'all') qs.set('status', nextTab);
      try {
        const res = await fetch(`/api/portal/admin/feedback?${qs}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPage((await res.json()) as FeedbackPage);
        setTab(nextTab);
        setOffset(nextOffset);
      } catch {
        setError('Could not load feedback. Try again.');
      }
    },
    [],
  );

  async function setStatus(id: string, status: FeedbackStatus) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load(tab, offset);
    } catch {
      setError('Could not update that item.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    // Feedback can contain whatever someone typed into a public box,
    // and the delete is a hard one, so confirm before it goes.
    if (
      !window.confirm(
        'Delete this feedback permanently? This also removes any screenshot.',
      )
    ) {
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/feedback/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Step back a page when the last row on this page just went.
      const nextOffset =
        page.items.length === 1 && offset >= PAGE_SIZE
          ? offset - PAGE_SIZE
          : offset;
      await load(tab, nextOffset);
    } catch {
      setError('Could not delete that item.');
    } finally {
      setBusy(null);
    }
  }

  const canPrev = offset > 0;
  const canNext = offset + page.items.length < page.total;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => void load(t.key, 0)}
            className={`rounded-md px-2.5 py-1.5 text-sm transition ${
              tab === t.key
                ? 'bg-accent/10 font-medium text-accent'
                : 'text-muted hover:bg-surface-2'
            }`}
          >
            {t.label}
            {t.key !== 'all' ? (
              <span className="ml-1.5 text-xs text-muted">
                {page.counts[t.key] ?? 0}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {page.items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-1 px-4 py-8 text-center text-sm text-muted">
          {tab === 'new'
            ? 'Nothing new. When someone sends feedback it lands here.'
            : 'Nothing here.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {page.items.map((row) => (
            <li
              key={row.id}
              className="rounded-lg border border-border bg-surface-1 p-4"
            >
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium text-ink-0">
                    {row.name || row.user?.fullName || 'Anonymous'}
                  </span>
                  {row.email ? (
                    <a
                      href={`mailto:${row.email}?subject=Re: your GratisGIS feedback`}
                      className="ml-2 text-accent hover:underline"
                    >
                      {row.email}
                    </a>
                  ) : null}
                  {row.user ? (
                    <span className="ml-2 text-xs text-muted">
                      signed in as {row.user.username}
                    </span>
                  ) : null}
                </div>
                <time
                  dateTime={row.createdAt}
                  className="text-xs text-muted"
                  title={new Date(row.createdAt).toLocaleString()}
                >
                  {new Date(row.createdAt).toLocaleString()}
                </time>
              </div>

              <p className="whitespace-pre-wrap text-sm text-ink-1">
                {row.message}
              </p>

              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {row.pageUrl ? (
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0">Page:</dt>
                    <dd className="truncate">
                      <a
                        href={row.pageUrl}
                        className="hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.pageUrl}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {row.appVersion ? (
                  <div className="flex gap-1">
                    <dt>Version:</dt>
                    <dd>{row.appVersion}</dd>
                  </div>
                ) : null}
                {row.viewport ? (
                  <div className="flex gap-1">
                    <dt>Window:</dt>
                    <dd>{row.viewport}</dd>
                  </div>
                ) : null}
                {row.userAgent ? (
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0">Browser:</dt>
                    <dd className="truncate" title={row.userAgent}>
                      {row.userAgent}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {row.hasScreenshot ? (
                <a
                  href={`/api/portal/admin/feedback/${row.id}/screenshot`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-ink-1 hover:bg-surface-2"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  View screenshot
                </a>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                {row.status !== 'handled' ? (
                  <ActionButton
                    busy={busy === row.id}
                    onClick={() => void setStatus(row.id, 'handled')}
                    icon={<Check className="h-3.5 w-3.5" />}
                    label="Mark handled"
                  />
                ) : null}
                {row.status !== 'spam' ? (
                  <ActionButton
                    busy={busy === row.id}
                    onClick={() => void setStatus(row.id, 'spam')}
                    label="Spam"
                  />
                ) : null}
                {row.status !== 'new' ? (
                  <ActionButton
                    busy={busy === row.id}
                    onClick={() => void setStatus(row.id, 'new')}
                    icon={<Undo2 className="h-3.5 w-3.5" />}
                    label="Back to new"
                  />
                ) : null}
                <button
                  type="button"
                  disabled={busy === row.id}
                  onClick={() => void remove(row.id)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-danger/5 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>

              {row.handledAt && row.handledBy ? (
                <p className="mt-2 text-xs text-muted">
                  {row.status === 'spam' ? 'Marked spam' : 'Handled'} by{' '}
                  {row.handledBy.fullName} on{' '}
                  {new Date(row.handledAt).toLocaleDateString()}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canPrev || canNext ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => void load(tab, Math.max(0, offset - PAGE_SIZE))}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Newer
          </button>
          <span className="text-xs text-muted">
            {offset + 1}-{offset + page.items.length} of {page.total}
          </span>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => void load(tab, offset + PAGE_SIZE)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 disabled:opacity-40"
          >
            Older
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  busy,
  onClick,
  icon,
  label,
}: {
  busy: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}
