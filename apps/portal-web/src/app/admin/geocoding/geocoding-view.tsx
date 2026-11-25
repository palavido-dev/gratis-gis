// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Plus, Save, Search, X } from 'lucide-react';

import { formatBytes } from '@/lib/format-bytes';
import { useT } from '@/lib/i18n/locale-context';
import { OpenAddressesConnect } from './openaddresses-connect';
import { RegionMap } from './region-map';

export type GeocoderStatus = 'none' | 'queued' | 'downloading' | 'building' | 'ready' | 'failed';
export type GeocoderRefresh = 'off' | 'monthly' | 'quarterly';

export interface GeocoderAdminView {
  available: boolean;
  locked: boolean;
  overriddenByEnv: boolean;
  serving: boolean;
  oaTokenSaved: boolean;
  settings: {
    regions: Array<{ id: string; name: string; pbfUrl: string }>;
    tiger: boolean;
    openAddresses: boolean;
    oaAccount: string | null;
    refresh: GeocoderRefresh;
    status: GeocoderStatus;
    statusMessage: string | null;
    startedAt: string | null;
    builtAt: string | null;
    builtRegions: string[];
    packBytes: number | null;
    log: string[];
  };
}

interface RegionOption {
  id: string;
  name: string;
  path: string[];
}

const API = '/api/portal/admin/geocoder';
const BUSY: GeocoderStatus[] = ['queued', 'downloading', 'building'];

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30';

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) msg = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    } catch {
      /* keep the status */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function GeocodingView({ initial }: { initial: GeocoderAdminView }) {
  const t = useT();
  const [view, setView] = useState(initial);
  const [picked, setPicked] = useState<RegionOption[]>(
    initial.settings.regions.map((r) => ({ id: r.id, name: r.name, path: [] })),
  );
  const [tiger, setTiger] = useState(initial.settings.tiger);
  const [openAddresses, setOpenAddresses] = useState(initial.settings.openAddresses);
  const [oaToken, setOaToken] = useState('');
  const [refresh, setRefresh] = useState<GeocoderRefresh>(initial.settings.refresh);
  const [regions, setRegions] = useState<RegionOption[] | null>(null);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pickMode, setPickMode] = useState<'list' | 'map'>('list');
  const [sizes, setSizes] = useState<{ total: number | null; us: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testQ, setTestQ] = useState('');
  const [testResults, setTestResults] = useState<
    Array<{ label: string; layer: string | null; accuracy: string | null }> | null
  >(null);
  const [testError, setTestError] = useState<string | null>(null);

  const s = view.settings;
  const busy = BUSY.includes(s.status);
  const readOnly = view.locked || !view.available;

  // Region list for the picker.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/regions`)
      .then((res) => readJson<{ regions: RegionOption[] }>(res))
      .then((body) => {
        if (cancelled) return;
        setRegions(body.regions);
        setPicked((prev) => prev.map((p) => body.regions.find((r) => r.id === p.id) ?? p));
      })
      .catch((err: unknown) => {
        if (!cancelled) setRegionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Download size of the picked regions.
  const pickedIds = picked.map((p) => p.id).join(',');
  useEffect(() => {
    if (!pickedIds) {
      setSizes(null);
      return;
    }
    let cancelled = false;
    fetch(`${API}/regions/size?ids=${encodeURIComponent(pickedIds)}`)
      .then((res) => readJson<{ sizes: Array<{ bytes: number | null }>; us: boolean }>(res))
      .then((body) => {
        if (cancelled) return;
        const known = body.sizes.every((x) => x.bytes !== null);
        setSizes({
          total: known ? body.sizes.reduce((a, x) => a + (x.bytes ?? 0), 0) : null,
          us: body.us,
        });
      })
      .catch(() => {
        if (!cancelled) setSizes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pickedIds]);

  // Poll while a build is running.
  const reload = useCallback(async () => {
    const next = await readJson<GeocoderAdminView>(await fetch(API));
    setView(next);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const handle = setInterval(() => {
      void reload().catch(() => undefined);
    }, 4000);
    return () => clearInterval(handle);
  }, [busy, reload]);

  const matches = useMemo(() => {
    if (!regions) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return regions
      .filter((r) => !picked.some((p) => p.id === r.id))
      .filter((r) => {
        const hay = `${r.name} ${r.path.join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 30);
  }, [regions, query, picked]);

  const dirty =
    pickedIds !== s.regions.map((r) => r.id).join(',') ||
    tiger !== s.tiger ||
    openAddresses !== s.openAddresses ||
    refresh !== s.refresh ||
    oaToken.trim().length > 0;

  async function save(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        regions: picked.map((p) => ({ id: p.id })),
        tiger,
        openAddresses,
        refresh,
      };
      if (oaToken.trim()) body.oaToken = oaToken.trim();
      const next = await readJson<GeocoderAdminView>(
        await fetch(API, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      setView(next);
      setOaToken('');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndBuild() {
    if (dirty && !(await save())) return;
    setSaving(true);
    setError(null);
    try {
      setView(await readJson<GeocoderAdminView>(await fetch(`${API}/build`, { method: 'POST' })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearToken() {
    setSaving(true);
    setError(null);
    try {
      setView(
        await readJson<GeocoderAdminView>(
          await fetch(API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regions: picked.map((p) => ({ id: p.id })),
              tiger,
              openAddresses: false,
              refresh,
              oaToken: null,
            }),
          }),
        ),
      );
      setOpenAddresses(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTestError(null);
    setTestResults(null);
    try {
      const body = await readJson<{
        results: Array<{ label: string; layer: string | null; accuracy: string | null }>;
      }>(await fetch(`${API}/test?q=${encodeURIComponent(testQ)}`));
      setTestResults(body.results);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    }
  }

  const statusLabel: Record<GeocoderStatus, string> = {
    none: t('adminGeocoding.statusNone'),
    queued: t('adminGeocoding.statusQueued'),
    downloading: t('adminGeocoding.statusDownloading'),
    building: t('adminGeocoding.statusBuilding'),
    ready: t('adminGeocoding.statusReady'),
    failed: t('adminGeocoding.statusFailed'),
  };

  return (
    <div className="space-y-6">
      {!view.available ? (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm">
          {t('adminGeocoding.unavailable')}
        </p>
      ) : null}
      {view.locked ? (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm">
          {t('adminGeocoding.locked')}
        </p>
      ) : null}
      {view.overriddenByEnv ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-ink-0">
          {t('adminGeocoding.overridden')}
        </p>
      ) : null}

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-base font-semibold">{t('adminGeocoding.statusTitle')}</h2>
        <div className="mt-2 flex items-center gap-2 text-sm">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : null}
          <span className="font-medium">{statusLabel[s.status]}</span>
          {s.statusMessage ? <span className="text-muted">· {s.statusMessage}</span> : null}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted">{t('adminGeocoding.serving')}</dt>
            <dd>{view.serving ? t('adminGeocoding.yes') : t('adminGeocoding.no')}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('adminGeocoding.builtAt')}</dt>
            <dd>{s.builtAt ? new Date(s.builtAt).toLocaleString() : '-'}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('adminGeocoding.indexSize')}</dt>
            <dd>{s.packBytes !== null ? formatBytes(s.packBytes) : '-'}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('adminGeocoding.builtRegions')}</dt>
            <dd>{s.builtRegions.length > 0 ? s.builtRegions.join(', ') : '-'}</dd>
          </div>
        </dl>
        {s.log.length > 0 ? (
          <details className="mt-3" open={busy || s.status === 'failed'}>
            <summary className="cursor-pointer text-sm text-muted">{t('adminGeocoding.log')}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-2 p-2 text-xs">
              {s.log.join('\n')}
            </pre>
          </details>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-base font-semibold">{t('adminGeocoding.regionsTitle')}</h2>
        <p className="mt-1 text-sm text-muted">{t('adminGeocoding.regionsHelp')}</p>

        {picked.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {picked.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1 text-sm"
              >
                {p.name}
                {!readOnly ? (
                  <button
                    type="button"
                    aria-label={t('adminGeocoding.remove', { name: p.name })}
                    className="rounded-full p-1 hover:bg-surface-1"
                    onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {sizes ? (
          <p className="mt-2 text-sm text-muted">
            {sizes.total !== null
              ? t('adminGeocoding.downloadSize', { size: formatBytes(sizes.total) })
              : t('adminGeocoding.downloadSizeUnknown')}
          </p>
        ) : null}

        {!readOnly ? (
          <>
            <div role="tablist" className="mt-3 flex gap-1">
              {(['list', 'map'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={pickMode === m}
                  className={`rounded-md px-2 py-1 text-xs ${
                    pickMode === m ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-surface-2'
                  }`}
                  onClick={() => setPickMode(m)}
                >
                  {m === 'list' ? t('adminGeocoding.pickList') : t('adminGeocoding.pickMap')}
                </button>
              ))}
            </div>
            {pickMode === 'map' ? (
              <RegionMap
                pickedIds={picked.map((p) => p.id)}
                onAdd={(r) =>
                  setPicked((prev) =>
                    prev.some((p) => p.id === r.id)
                      ? prev
                      : [...prev, regions?.find((x) => x.id === r.id) ?? { id: r.id, name: r.name, path: [] }],
                  )
                }
              />
            ) : (
              <div className="mt-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted" />
                <input
                  className={`${inputClass} pl-8`}
                  placeholder={t('adminGeocoding.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('adminGeocoding.searchPlaceholder')}
                />
              </label>
              {regionError ? <p className="mt-2 text-sm text-danger">{regionError}</p> : null}
              {regions === null && !regionError ? (
                <p className="mt-2 text-sm text-muted">{t('adminGeocoding.loadingRegions')}</p>
              ) : null}
              {matches.length > 0 ? (
                <ul className="mt-2 max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
                  {matches.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                        onClick={() => {
                          setPicked((prev) => [...prev, r]);
                          setQuery('');
                        }}
                      >
                        <span>
                          <span className="font-medium">{r.name}</span>
                          {r.path.length > 0 ? (
                            <span className="ml-2 text-muted">{r.path.join(' / ')}</span>
                          ) : null}
                        </span>
                        <Plus className="h-4 w-4 shrink-0 text-muted" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            )}
          </>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-base font-semibold">{t('adminGeocoding.sourcesTitle')}</h2>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-muted">{t('adminGeocoding.sourceOsm')}</p>
          {sizes?.us || tiger !== true ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={tiger}
                disabled={readOnly}
                onChange={(e) => setTiger(e.target.checked)}
              />
              <span>{t('adminGeocoding.sourceTiger')}</span>
            </label>
          ) : null}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={openAddresses}
              disabled={readOnly}
              onChange={(e) => setOpenAddresses(e.target.checked)}
            />
            <span>{t('adminGeocoding.sourceOa')}</span>
          </label>
          {openAddresses && !readOnly ? (
            <OpenAddressesConnect
              view={view}
              onView={(next) => {
                setView(next);
                setOpenAddresses(next.settings.openAddresses);
              }}
              oaToken={oaToken}
              setOaToken={setOaToken}
              onClear={() => void clearToken()}
              busy={saving}
            />
          ) : null}
          <label className="flex items-center gap-2">
            <span>{t('adminGeocoding.refresh')}</span>
            <select
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm"
              value={refresh}
              disabled={readOnly}
              onChange={(e) => setRefresh(e.target.value as GeocoderRefresh)}
            >
              <option value="off">{t('adminGeocoding.refreshOff')}</option>
              <option value="monthly">{t('adminGeocoding.refreshMonthly')}</option>
              <option value="quarterly">{t('adminGeocoding.refreshQuarterly')}</option>
            </select>
          </label>
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</p>
      ) : null}

      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
            disabled={saving || busy || picked.length === 0}
            onClick={() => void saveAndBuild()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {s.status === 'ready' || s.builtAt ? t('adminGeocoding.rebuild') : t('adminGeocoding.build')}
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm disabled:opacity-50"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" />
            {t('adminGeocoding.saveOnly')}
          </button>
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-base font-semibold">{t('adminGeocoding.testTitle')}</h2>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runTest();
          }}
        >
          <input
            className={inputClass}
            placeholder={t('adminGeocoding.testPlaceholder')}
            value={testQ}
            onChange={(e) => setTestQ(e.target.value)}
            aria-label={t('adminGeocoding.testPlaceholder')}
          />
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm disabled:opacity-50"
            disabled={!view.serving || testQ.trim().length < 3}
          >
            {t('adminGeocoding.testButton')}
          </button>
        </form>
        {!view.serving ? <p className="mt-2 text-sm text-muted">{t('adminGeocoding.testNotServing')}</p> : null}
        {testError ? <p className="mt-2 text-sm text-danger">{testError}</p> : null}
        {testResults ? (
          testResults.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('adminGeocoding.testNoMatch')}</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {testResults.map((r, i) => (
                <li key={i}>
                  {r.label}{' '}
                  <span className="text-muted">
                    ({[r.layer, r.accuracy].filter(Boolean).join(' · ')})
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
