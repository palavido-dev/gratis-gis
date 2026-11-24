// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  KeyRound,
  Loader2,
  PlugZap,
  RotateCcw,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';
import { useFormat } from '@/lib/i18n/format';
import { formatBytes } from '@/lib/format-bytes';

/**
 * Off-site settings as GET /admin/backup/offsite returns them. The two
 * secrets are never sent to the browser; only whether each one is set
 * and where it came from.
 */
interface OffsiteConfig {
  enabled: boolean;
  endpoint: string | null;
  region: string;
  bucket: string | null;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string | null;
  hasSecretAccessKey: boolean;
  secretAccessKeySource: 'database' | 'environment' | null;
  hasPassphrase: boolean;
  passphraseSource: 'database' | 'environment' | null;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdBytes: number;
  complete: boolean;
  missing: string[];
  status: {
    lastSuccess: {
      runId: string;
      finishedAt: string;
      mode: string | null;
      bytes: string | null;
    } | null;
    lastFailure: { runId: string; finishedAt: string | null; error: string | null } | null;
    running: { runId: string; startedAt: string | null } | null;
    daysSinceSuccess: number | null;
    alert: boolean;
  };
}

interface Draft {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  passphrase: string;
  passphraseConfirm: string;
  passphraseStored: boolean;
  retentionDays: number;
  alertDays: number;
  mirrorThresholdGb: number;
}

const GB = 1024 ** 3;

function toDraft(c: OffsiteConfig): Draft {
  return {
    enabled: c.enabled,
    endpoint: c.endpoint ?? '',
    region: c.region,
    bucket: c.bucket ?? '',
    prefix: c.prefix,
    pathStyle: c.pathStyle,
    accessKeyId: c.accessKeyId ?? '',
    secretAccessKey: '',
    passphrase: '',
    passphraseConfirm: '',
    passphraseStored: false,
    retentionDays: c.retentionDays,
    alertDays: c.alertDays,
    mirrorThresholdGb: Math.round(c.mirrorThresholdBytes / GB),
  };
}

async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return typeof msg === 'string' && msg.trim() ? msg : null;
  } catch {
    return null;
  }
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none';

/**
 * Off-site copies: settings, a connection test, and the state of the
 * last copy. Hidden when the API refuses (admins of organizations that
 * are not the operator).
 */
export function OffsiteSection() {
  const t = useT();
  const fmt = useFormat();
  const [config, setConfig] = useState<OffsiteConfig | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/admin/backup/offsite');
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as OffsiteConfig;
      setConfig(body);
      setDraft((d) => (d === null ? toDraft(body) : d));
    } catch {
      // The rest of the page still works; the section stays hidden.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return <p className="text-xs text-muted">{t('adminBackup.offsite.notOperator')}</p>;
  }
  if (!config || !draft) return null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const newPassphrase = draft.passphrase.length > 0;

  async function save() {
    if (!draft || !config) return;
    if (newPassphrase && !draft.passphraseStored) {
      setMessage({ ok: false, text: t('adminBackup.offsite.passphraseStoredRequired') });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        endpoint: draft.endpoint.trim() || null,
        region: draft.region.trim() || null,
        bucket: draft.bucket.trim() || null,
        prefix: draft.prefix,
        pathStyle: draft.pathStyle,
        accessKeyId: draft.accessKeyId.trim() || null,
        retentionDays: draft.retentionDays,
        alertDays: draft.alertDays,
        mirrorThresholdBytes: Math.round(draft.mirrorThresholdGb * GB),
      };
      // Secrets only when typed: a blank field keeps the saved one.
      if (draft.secretAccessKey) body.secretAccessKey = draft.secretAccessKey;
      if (newPassphrase) {
        body.passphrase = draft.passphrase;
        body.passphraseConfirm = draft.passphraseConfirm;
      }
      const res = await fetch('/api/portal/admin/backup/offsite', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setMessage({
          ok: false,
          text: (await serverMessage(res)) ?? t('adminBackup.offsite.saveFailed'),
        });
        return;
      }
      const next = (await res.json()) as OffsiteConfig;
      setConfig(next);
      setDraft(toDraft(next));
      setMessage({ ok: true, text: t('adminBackup.offsite.saved') });
    } catch {
      setMessage({ ok: false, text: t('adminBackup.offsite.saveFailed') });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/portal/admin/backup/offsite/test', { method: 'POST' });
      if (!res.ok) {
        setMessage({
          ok: false,
          text: (await serverMessage(res)) ?? t('adminBackup.offsite.saveFailed'),
        });
        return;
      }
      const body = (await res.json()) as { ok: boolean; message: string };
      setMessage({ ok: body.ok, text: body.message });
    } finally {
      setTesting(false);
    }
  }

  const st = config.status;
  const secretHint =
    config.secretAccessKeySource === 'environment'
      ? t('adminBackup.offsite.secretFromEnv')
      : config.hasSecretAccessKey
        ? t('adminBackup.offsite.secretSaved')
        : null;
  const passHint =
    config.passphraseSource === 'environment'
      ? t('adminBackup.offsite.secretFromEnv')
      : config.hasPassphrase
        ? t('adminBackup.offsite.passphraseSaved')
        : null;

  return (
    <section
      className="rounded-lg border border-border bg-surface-1"
      aria-labelledby="offsite-title"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 id="offsite-title" className="flex items-center gap-2 text-sm font-medium text-ink-0">
          <CloudUpload className="h-4 w-4" aria-hidden />
          {t('adminBackup.offsite.title')}
        </h2>
        <p className="text-xs text-muted">
          {t('adminBackup.offsite.intro')}{' '}
          <a className="text-accent underline" href="/help/admin/offsite-backups">
            {t('adminBackup.offsite.helpLink')}
          </a>
        </p>
      </header>

      <div className="space-y-4 px-4 py-4 text-sm">
        {st.alert ? (
          <p
            role="status"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800"
          >
            <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden />
            {t('adminBackup.offsite.alert')}
          </p>
        ) : null}
        <div className="space-y-1 text-xs text-muted">
          <p>
            {st.lastSuccess
              ? t('adminBackup.offsite.lastGood', {
                  when: fmt.dateTime(st.lastSuccess.finishedAt),
                  size: st.lastSuccess.bytes ? formatBytes(BigInt(st.lastSuccess.bytes)) : '?',
                })
              : t('adminBackup.offsite.lastGoodNever')}
          </p>
          {st.lastFailure ? (
            <p>
              {t('adminBackup.offsite.lastFailed', {
                when: st.lastFailure.finishedAt ? fmt.dateTime(st.lastFailure.finishedAt) : '?',
                error: st.lastFailure.error ?? '',
              })}
            </p>
          ) : null}
          {st.running ? <p>{t('adminBackup.offsite.uploading')}</p> : null}
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span className="font-medium text-ink-0">{t('adminBackup.offsite.enabled')}</span>
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.endpoint')}
            </span>
            <input
              className={inputClass}
              value={draft.endpoint}
              onChange={(e) => set('endpoint', e.target.value)}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-2xs text-muted">{t('adminBackup.offsite.endpointHint')}</span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.region')}
            </span>
            <input
              className={inputClass}
              value={draft.region}
              onChange={(e) => set('region', e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.bucket')}
            </span>
            <input
              className={inputClass}
              value={draft.bucket}
              onChange={(e) => set('bucket', e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.prefix')}
            </span>
            <input
              className={inputClass}
              value={draft.prefix}
              onChange={(e) => set('prefix', e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs text-ink-1">
            <input
              type="checkbox"
              checked={draft.pathStyle}
              onChange={(e) => set('pathStyle', e.target.checked)}
            />
            {t('adminBackup.offsite.pathStyle')}
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.accessKeyId')}
            </span>
            <input
              className={inputClass}
              value={draft.accessKeyId}
              onChange={(e) => set('accessKeyId', e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.secretAccessKey')}
            </span>
            <input
              className={inputClass}
              type="password"
              value={draft.secretAccessKey}
              onChange={(e) => set('secretAccessKey', e.target.value)}
              autoComplete="new-password"
            />
            {secretHint ? <span className="text-2xs text-muted">{secretHint}</span> : null}
          </label>
        </div>

        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-3">
          <p className="flex items-center gap-2 font-medium text-ink-0">
            <KeyRound className="h-4 w-4" aria-hidden />
            {t('adminBackup.offsite.passphraseWarningTitle')}
          </p>
          <p className="mt-1 text-xs text-ink-1">{t('adminBackup.offsite.passphraseWarning')}</p>
          {config.hasPassphrase ? (
            <p className="mt-1 text-xs text-ink-1">{t('adminBackup.offsite.passphraseChange')}</p>
          ) : null}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-ink-1">
                {t('adminBackup.offsite.passphrase')}
              </span>
              <input
                className={inputClass}
                type="password"
                value={draft.passphrase}
                onChange={(e) => set('passphrase', e.target.value)}
                autoComplete="new-password"
              />
              {passHint ? <span className="text-2xs text-muted">{passHint}</span> : null}
            </label>
            <label className="block">
              <span className="text-xs font-medium text-ink-1">
                {t('adminBackup.offsite.passphraseConfirm')}
              </span>
              <input
                className={inputClass}
                type="password"
                value={draft.passphraseConfirm}
                onChange={(e) => set('passphraseConfirm', e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>
          {newPassphrase ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-0">
              <input
                type="checkbox"
                checked={draft.passphraseStored}
                onChange={(e) => set('passphraseStored', e.target.checked)}
              />
              {t('adminBackup.offsite.passphraseStored')}
            </label>
          ) : null}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.retentionDays')}
            </span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={3650}
              value={draft.retentionDays}
              onChange={(e) => set('retentionDays', Number(e.target.value))}
            />
            <span className="text-2xs text-muted">{t('adminBackup.offsite.retentionHint')}</span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.alertDays')}
            </span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={90}
              value={draft.alertDays}
              onChange={(e) => set('alertDays', Number(e.target.value))}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.mirrorThresholdGb')}
            </span>
            <input
              className={inputClass}
              type="number"
              min={1}
              value={draft.mirrorThresholdGb}
              onChange={(e) => set('mirrorThresholdGb', Number(e.target.value))}
            />
          </label>
        </div>

        {message ? (
          <p
            role="status"
            className={message.ok ? 'text-xs text-emerald-700' : 'text-xs text-danger'}
          >
            {message.ok ? (
              <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            ) : (
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            )}
            {message.text}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('adminBackup.offsite.saving') : t('adminBackup.offsite.save')}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={testing}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-ink-0 hover:bg-surface-2 disabled:opacity-60"
          >
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="h-4 w-4" />
            )}
            {testing ? t('adminBackup.offsite.testing') : t('adminBackup.offsite.test')}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * The off-site state of one run, under its status in the history
 * table, with "Upload again" when the copy failed.
 */
export function OffsiteRunBadge({
  run,
  onChanged,
}: {
  run: {
    id: string;
    offsiteStatus?: string | null;
    offsiteMode?: string | null;
    offsiteError?: string | null;
  };
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!run.offsiteStatus || run.offsiteStatus === 'skipped') return null;

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/backup/runs/${run.id}/offsite`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError((await serverMessage(res)) ?? t('adminBackup.offsite.retryFailed'));
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (run.offsiteStatus === 'running') {
    return (
      <span className="mt-1 flex items-center gap-1 text-2xs text-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {t('adminBackup.offsite.statusRunning')}
      </span>
    );
  }
  if (run.offsiteStatus === 'succeeded') {
    return (
      <span className="mt-1 flex items-center gap-1 text-2xs text-emerald-700">
        <ShieldCheck className="h-3 w-3" aria-hidden />
        {run.offsiteMode === 'mirror'
          ? t('adminBackup.offsite.statusMirror')
          : t('adminBackup.offsite.statusSucceeded')}
      </span>
    );
  }
  return (
    <span className="mt-1 block text-2xs text-danger" title={run.offsiteError ?? undefined}>
      <XCircle className="mr-1 inline h-3 w-3" aria-hidden />
      {t('adminBackup.offsite.statusFailed')}{' '}
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="ml-1 inline-flex items-center gap-1 underline"
      >
        <RotateCcw className="h-3 w-3" aria-hidden />
        {busy ? t('adminBackup.offsite.retrying') : t('adminBackup.offsite.retry')}
      </button>
      {error ? <span className="block">{error}</span> : null}
    </span>
  );
}

interface RestoreTest {
  id: string;
  filename: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'passed' | 'failed';
  summary: { organizations: number; users: number; items: number; migrations: number } | null;
  error: string | null;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Test latest backup": restores the newest dump into a scratch
 * database and reports what it found. Reminds the admin when no test
 * has passed in 30 days.
 */
export function RestoreTestSection() {
  const t = useT();
  const fmt = useFormat();
  const [tests, setTests] = useState<RestoreTest[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/admin/backup/restore-tests');
      if (!res.ok) return;
      setTests((await res.json()) as RestoreTest[]);
    } catch {
      // Try again on the next poll.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const running = tests?.some((x) => x.status === 'running') ?? false;
    if (running && !poll.current) poll.current = setInterval(() => void load(), 3000);
    if (!running && poll.current) {
      clearInterval(poll.current);
      poll.current = null;
    }
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
        poll.current = null;
      }
    };
  }, [tests, load]);

  if (tests === null) return null;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/backup/restore-tests', { method: 'POST' });
      if (!res.ok) {
        setError((await serverMessage(res)) ?? t('adminBackup.test.failedToStart'));
        return;
      }
      await load();
    } finally {
      setStarting(false);
    }
  }

  const lastPassed = tests.find((x) => x.status === 'passed');
  const now = Date.now();
  const remind = !lastPassed || now - new Date(lastPassed.startedAt).getTime() > MONTH_MS;
  const running = tests.some((x) => x.status === 'running');

  return (
    <section
      className="rounded-lg border border-border bg-surface-1"
      aria-labelledby="restore-test-title"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="restore-test-title" className="text-sm font-medium text-ink-0">
            {t('adminBackup.test.title')}
          </h2>
          <p className="text-xs text-muted">{t('adminBackup.test.intro')}</p>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={starting || running}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-ink-0 hover:bg-surface-2 disabled:opacity-60"
        >
          {starting || running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {starting
            ? t('adminBackup.test.starting')
            : running
              ? t('adminBackup.test.running')
              : t('adminBackup.test.run')}
        </button>
      </header>
      <div className="space-y-2 px-4 py-3 text-sm">
        {remind ? (
          <p
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-ink-0"
          >
            {t('adminBackup.test.reminder')}
          </p>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {tests.length === 0 ? (
          <p className="text-xs text-muted">{t('adminBackup.test.none')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {tests.slice(0, 5).map((x) => (
              <li key={x.id} className="py-2 text-xs">
                <span className="mr-2 font-medium">
                  {x.status === 'passed' ? (
                    <span className="text-emerald-700">{t('adminBackup.test.passed')}</span>
                  ) : x.status === 'failed' ? (
                    <span className="text-danger">{t('adminBackup.test.failed')}</span>
                  ) : (
                    <span className="text-muted">{t('adminBackup.test.running')}</span>
                  )}
                </span>
                <span className="text-muted">
                  {fmt.dateTime(x.startedAt)}
                  {x.filename ? ` · ${x.filename}` : ''}
                </span>
                {x.summary ? (
                  <span className="block text-muted">
                    {t('adminBackup.test.counts', { ...x.summary })}
                  </span>
                ) : null}
                {x.error ? <span className="block text-danger">{x.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
