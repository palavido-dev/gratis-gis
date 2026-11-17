// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';

import { useT } from '@/lib/i18n/locale-context';

interface PermissionRow {
  itemId: string;
  title: string;
  itemType: string;
  access: string;
  ownerId: string;
  ownerUsername: string | null;
  ownerMissing: boolean;
  principalType: string;
  principalId: string;
  permission: string;
  principalMissing: boolean;
}

export function PermissionsView() {
  const t = useT();
  const [rows, setRows] = useState<PermissionRow[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/permissions');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        kind: string;
        generatedAt: string;
        rows: PermissionRow[];
      };
      setRows(body.rows);
      setGeneratedAt(body.generatedAt);
    } catch {
      setError(t('adminPermissions.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">{t('adminPermissions.title')}</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-1">{t('adminPermissions.intro')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? t('adminPermissions.loading') : t('adminPermissions.refresh')}
        </button>
        <a
          className="rounded-md border border-border px-3 py-2 text-sm"
          href="/api/portal/admin/permissions/export.csv"
        >
          {t('adminPermissions.download')}
        </a>
      </div>
      {error ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {generatedAt ? (
        <p className="mt-4 text-xs text-ink-1">
          {t('adminPermissions.generated', { at: generatedAt })}
        </p>
      ) : null}
      {rows && rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-1">{t('adminPermissions.empty')}</p>
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-ink-1">
                <th className="py-2 pr-3 font-medium">{t('adminPermissions.item')}</th>
                <th className="py-2 pr-3 font-medium">{t('adminPermissions.access')}</th>
                <th className="py-2 pr-3 font-medium">{t('adminPermissions.owner')}</th>
                <th className="py-2 font-medium">{t('adminPermissions.share')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.itemId}-${index}`} className="border-b border-border/60">
                  <td className="py-2 pr-3">{row.title}</td>
                  <td className="py-2 pr-3">{row.access}</td>
                  <td className="py-2 pr-3">
                    {row.ownerMissing
                      ? t('adminPermissions.missingOwner')
                      : (row.ownerUsername ?? row.ownerId)}
                  </td>
                  <td className="py-2">
                    {row.principalType
                      ? `${row.principalType} ${row.permission}${
                          row.principalMissing ? ` (${t('adminPermissions.missingPrincipal')})` : ''
                        }`
                      : t('adminPermissions.tierOnly')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
