// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import Link from 'next/link';

import { useT } from '@/lib/i18n/locale-context';

export interface UpdateReport {
  current: { version: string; gitSha: string | null; composeRev: string | null };
  latest: { version: string | null; gitSha: string | null } | null;
  channel: string;
  releaseNotesUrl: string | null;
  composeOutdated: boolean;
  installType: 'nas' | 'vps' | 'dev';
  updateAvailable: boolean;
  breaking: string[];
  offline: boolean;
}

function composeRawUrl(report: UpdateReport): string {
  const repo = process.env.NEXT_PUBLIC_GITHUB_REPO || 'palavido-dev/gratis-gis';
  const ref =
    report.channel === 'edge'
      ? 'main'
      : report.channel === 'latest'
        ? report.latest?.version || 'main'
        : report.channel;
  return `https://raw.githubusercontent.com/${repo}/${ref}/infra/docker-compose.nas.yml`;
}

function latestLabel(report: UpdateReport): string {
  if (report.latest?.version) return report.latest.version;
  if (report.latest?.gitSha) return report.latest.gitSha.slice(0, 12);
  return '—';
}

export function UpdatesView({
  report,
  backupDisabled = false,
}: {
  report: UpdateReport;
  backupDisabled?: boolean;
}) {
  const t = useT();
  const [backup, setBackup] = useState<{ id?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function createBackup() {
    setBusy(true);
    setBackup(null);
    try {
      const res = await fetch('/api/portal/admin/backup/runs', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { id?: string };
      if (body.id) setBackup({ id: body.id });
      else setBackup({ error: t('updates.backupFailed') });
    } catch (err) {
      setBackup({ error: err instanceof Error ? err.message : t('updates.backupFailed') });
    } finally {
      setBusy(false);
    }
  }

  const nasCompose = report.installType === 'nas' && report.composeOutdated;
  const nasImages = report.installType === 'nas' && !report.composeOutdated;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">{t('updates.current')}</dt>
            <dd className="font-medium">{report.current.version}</dd>
            {report.current.gitSha ? (
              <dd className="font-mono text-xs text-muted">{report.current.gitSha.slice(0, 12)}</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs text-muted">{t('updates.latest')}</dt>
            <dd className="font-medium">{latestLabel(report)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('updates.channel')}</dt>
            <dd className="font-medium">{report.channel}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('updates.install')}</dt>
            <dd className="font-medium">{report.installType}</dd>
          </div>
        </dl>
        {report.offline ? (
          <p className="mt-3 text-sm text-muted">{t('updates.offline')}</p>
        ) : null}
        {report.releaseNotesUrl ? (
          <p className="mt-3 text-sm">
            <a
              href={report.releaseNotesUrl}
              className="text-accent underline"
              target="_blank"
              rel="noreferrer"
            >
              {t('updates.changelog')}
            </a>
          </p>
        ) : null}
        {report.breaking.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {report.breaking.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <ol className="list-decimal space-y-4 pl-5 text-sm">
        {backupDisabled ? (
          <li className="text-muted">{t('opsPage.backupUiDisabled')}</li>
        ) : (
          <li>
            <button
              type="button"
              onClick={createBackup}
              disabled={busy}
              className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:opacity-60"
            >
              {busy ? t('updates.backupWorking') : t('updates.createBackup')}
            </button>
            {backup?.id ? (
              <span className="ml-3">
                <a
                  className="text-accent underline"
                  href={`/api/portal/admin/backup/runs/${backup.id}/download`}
                >
                  {t('updates.downloadBackup')}
                </a>
                <Link href="/admin/backup" className="ml-3 text-accent underline">
                  {t('updates.backupPage')}
                </Link>
              </span>
            ) : null}
            {backup?.error ? <p className="mt-1 text-danger">{backup.error}</p> : null}
          </li>
        )}
        {nasCompose ? (
          <li>
            {t('updates.nasCompose')}{' '}
            <a className="text-accent underline" href={composeRawUrl(report)}>
              docker-compose.nas.yml
            </a>
            . {t('updates.nasComposePaste')}
          </li>
        ) : null}
        {nasImages ? <li>{t('updates.nasImages')}</li> : null}
        {report.installType === 'vps' ? (
          <li>
            <code className="rounded bg-surface-2 px-1">./infra/deploy.sh</code>
          </li>
        ) : null}
        {report.installType === 'dev' ? <li>{t('updates.dev')}</li> : null}
      </ol>
    </div>
  );
}
