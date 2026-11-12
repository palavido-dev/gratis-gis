// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';

import { useT } from '@/lib/i18n/locale-context';

interface JobRow {
  id: string;
  kind: 'import' | 'analysis' | 'backup';
  source: string;
  type: string;
  status: string;
  error: string | null;
  actions: { cancel: boolean; retry: boolean };
}

export function JobsView() {
  const t = useT();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    setBusy('load');
    try {
      const res = await fetch('/api/portal/admin/jobs');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { jobs: JobRow[] };
      setJobs(body.jobs);
    } catch {
      setError(t('opsJobs.loadFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function act(job: JobRow, verb: 'cancel' | 'retry') {
    setBusy(`${job.id}:${verb}`);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/jobs/${job.id}/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: job.kind }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await load();
    } catch {
      setError(t('opsJobs.actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">{t('opsJobs.title')}</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-1">{t('opsJobs.intro')}</p>
      <button
        type="button"
        className="mt-4 rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
        onClick={() => void load()}
        disabled={busy !== null}
      >
        {busy === 'load' ? t('opsJobs.loading') : t('opsJobs.refresh')}
      </button>
      {error ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {jobs && jobs.length === 0 ? <p className="mt-6 text-sm">{t('opsJobs.empty')}</p> : null}
      {jobs && jobs.length > 0 ? (
        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-ink-1">
              <th className="py-2 pr-3">{t('opsJobs.kind')}</th>
              <th className="py-2 pr-3">{t('opsJobs.source')}</th>
              <th className="py-2 pr-3">{t('opsJobs.status')}</th>
              <th className="py-2">{t('opsJobs.error')}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={`${job.kind}-${job.id}`} className="border-b border-border/60">
                <td className="py-2 pr-3">{job.kind}</td>
                <td className="py-2 pr-3">{job.source}</td>
                <td className="py-2 pr-3">
                  {job.status}
                  {job.actions.cancel ? (
                    <button type="button" className="ml-2 underline" onClick={() => void act(job, 'cancel')}>
                      {t('opsJobs.cancel')}
                    </button>
                  ) : null}
                  {job.actions.retry ? (
                    <button type="button" className="ml-2 underline" onClick={() => void act(job, 'retry')}>
                      {t('opsJobs.retry')}
                    </button>
                  ) : null}
                </td>
                <td className="py-2">{job.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
