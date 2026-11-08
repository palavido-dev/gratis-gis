// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';

import { useT } from '@/lib/i18n/locale-context';

export function DiagnosticsView() {
  const t = useT();
  const [bundle, setBundle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function createBundle() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/diagnostics/bundle', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const body: unknown = await res.json();
      setBundle(JSON.stringify(body, null, 2));
    } catch {
      setError(t('adminDiagnostics.failed'));
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!bundle) return;
    const blob = new Blob([bundle], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gratis-diagnostics.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">{t('adminDiagnostics.title')}</h1>
      <p className="mt-2 text-sm text-ink-1">{t('adminDiagnostics.intro')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
          onClick={() => void createBundle()}
          disabled={loading}
        >
          {loading ? t('adminDiagnostics.working') : t('adminDiagnostics.create')}
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-3 py-2 text-sm disabled:opacity-60"
          onClick={download}
          disabled={!bundle}
        >
          {t('adminDiagnostics.download')}
        </button>
      </div>
      {error ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {bundle ? (
        <pre className="mt-6 overflow-x-auto rounded-md bg-surface-2 p-4 text-xs text-ink-0">
          {bundle}
        </pre>
      ) : null}
    </div>
  );
}
