// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';

import { useT } from '@/lib/i18n/locale-context';

export function OperationsView({
  operator,
  writesDisabled = false,
}: {
  operator: boolean;
  writesDisabled?: boolean;
}) {
  const t = useT();
  const [readiness, setReadiness] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(path: string, init: RequestInit | undefined, assign: (text: string) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, init);
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 180) || String(res.status));
      assign(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('opsPage.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold text-ink-0">{t('opsPage.title')}</h1>
        <p className="mt-2 text-sm text-ink-1">{t('opsPage.intro')}</p>
      </div>
      {!operator ? <p className="text-sm text-ink-1">{t('opsPage.operatorOnly')}</p> : null}
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {operator ? (
        <>
          <section>
            <h2 className="text-sm font-medium">{t('opsPage.readiness')}</h2>
            <button
              type="button"
              className="mt-2 rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
              disabled={busy}
              onClick={() => void run('/api/portal/admin/readiness', undefined, setReadiness)}
            >
              {t('opsPage.check')}
            </button>
            {readiness ? <pre className="mt-3 overflow-x-auto text-xs">{readiness}</pre> : null}
          </section>
          <section>
            <h2 className="text-sm font-medium">{t('opsPage.maintenance')}</h2>
            <p className="mt-1 text-sm text-ink-1">{t('opsPage.maintenanceHint')}</p>
            {writesDisabled ? (
              <p className="mt-2 text-sm text-muted">{t('opsPage.backupUiDisabled')}</p>
            ) : (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-2 text-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      '/api/portal/admin/maintenance',
                      {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ active: true }),
                      },
                      setMaintenance,
                    )
                  }
                >
                  {t('opsPage.maintenanceOn')}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-2 text-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      '/api/portal/admin/maintenance',
                      {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ active: false }),
                      },
                      setMaintenance,
                    )
                  }
                >
                  {t('opsPage.maintenanceOff')}
                </button>
              </div>
            )}
            {maintenance ? <pre className="mt-3 overflow-x-auto text-xs">{maintenance}</pre> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
