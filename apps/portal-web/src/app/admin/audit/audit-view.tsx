// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';

import { useT } from '@/lib/i18n/locale-context';

interface AuditEvent {
  id: string;
  at: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  outcome: string;
  detail: Record<string, string | number | boolean>;
}

export function AuditView() {
  const t = useT();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(before?: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (before) qs.set('before', before);
      const res = await fetch(`/api/portal/admin/audit?${qs.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        events: AuditEvent[];
        nextBefore: string | null;
      };
      setEvents((prev) => (before ? [...prev, ...body.events] : body.events));
      setNextBefore(body.nextBefore);
    } catch {
      setError(t('adminAudit.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">{t('adminAudit.title')}</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-1">{t('adminAudit.intro')}</p>
      <button
        type="button"
        className="mt-4 rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
        onClick={() => void load()}
        disabled={loading}
      >
        {loading ? t('adminAudit.loading') : t('adminAudit.refresh')}
      </button>
      {error ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {events.length === 0 && !error ? (
        <p className="mt-6 text-sm text-ink-1">{t('adminAudit.empty')}</p>
      ) : null}
      {events.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-ink-1">
                <th className="py-2 pr-3 font-medium">{t('adminAudit.when')}</th>
                <th className="py-2 pr-3 font-medium">{t('adminAudit.action')}</th>
                <th className="py-2 pr-3 font-medium">{t('adminAudit.actor')}</th>
                <th className="py-2 pr-3 font-medium">{t('adminAudit.target')}</th>
                <th className="py-2 font-medium">{t('adminAudit.outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-b border-border/60">
                  <td className="py-2 pr-3 whitespace-nowrap">{event.at}</td>
                  <td className="py-2 pr-3">{event.action}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{event.actorUserId ?? '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {event.targetType}:{event.targetId || '—'}
                  </td>
                  <td className="py-2">{event.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {nextBefore ? (
        <button
          type="button"
          className="mt-4 rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => void load(nextBefore)}
          disabled={loading}
        >
          {t('adminAudit.more')}
        </button>
      ) : null}
    </div>
  );
}
