'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  Mail,
  RefreshCcw,
  RotateCw,
  Save,
  Send,
  X,
} from 'lucide-react';

export interface Stats {
  queueDepth: number;
  failedTotal: number;
  sentLast24h: number;
  failedLast24h: number;
  avgLatencyMs: number | null;
  byType: Array<{
    type: string;
    label: string;
    queued: number;
    sent: number;
    failed: number;
  }>;
}

export interface RecentRow {
  id: string;
  type: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  address: string;
  attempts: number;
  lastError: string | null;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

export interface SmtpState {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  fromAddress: string;
  fromDisplayName: string;
  user: string;
  hasPassword: boolean;
  /** When the API saved successfully but realm-side push to Keycloak
   *  failed, the actionable message lands here (#139). The DB save +
   *  worker reload still happened, so non-realm emails work; realm-
   *  issued emails (invite / forgot-password / verify) won't go out
   *  until the underlying issue is fixed. */
  realmSyncWarning?: string;
}

export interface DefaultsRow {
  type: string;
  channel: 'email';
  label: string;
  category: string;
  codeDefault: boolean;
  effective: boolean;
  isOverride: boolean;
}

interface PreviewPayload {
  type: string;
  label: string;
  subject: string;
  text: string;
  html: string;
}

interface Props {
  initialStats: Stats;
  initialRecent: RecentRow[];
  initialSmtp: SmtpState;
  initialDefaults: DefaultsRow[];
}

/**
 * Admin notifications dashboard view (#130, extended in #137). Adds
 * three editable surfaces on top of the original health metrics:
 *
 *   - SMTP card: form-edit + send-test + status badges so admins
 *     configure the relay from the UI rather than env files.
 *   - Defaults toggles: per-NotificationType org-wide on/off folded
 *     into the existing By Type rollup. An admin muting a type here
 *     turns it off for every user who hasn't explicitly opted in.
 *   - Preview modal: per-type "see what the email looks like"
 *     rendered against a hardcoded sample payload from the server.
 */
export function NotificationsAdminView({
  initialStats,
  initialRecent,
  initialSmtp,
  initialDefaults,
}: Props) {
  const [stats, setStats] = useState<Stats>(initialStats);
  const [recent, setRecent] = useState<RecentRow[]>(initialRecent);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        fetch('/api/portal/admin/notifications/stats').then(
          (res) => res.json() as Promise<Stats>,
        ),
        fetch('/api/portal/admin/notifications/recent').then(
          (res) => res.json() as Promise<RecentRow[]>,
        ),
      ]);
      setStats(s);
      setRecent(r);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Refresh failed; try again.',
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function retry(id: string) {
    setRetryingId(id);
    setError(null);
    const prev = recent;
    setRecent((cur) =>
      cur.map((r) =>
        r.id === id
          ? { ...r, status: 'queued', attempts: 0, lastError: null }
          : r,
      ),
    );
    try {
      const res = await fetch(
        `/api/portal/admin/notifications/${id}/retry`,
        { method: 'POST' },
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      const s = (await fetch(
        '/api/portal/admin/notifications/stats',
      ).then((r) => r.json())) as Stats;
      setStats(s);
    } catch (err) {
      setRecent(prev);
      setError(
        err instanceof Error ? err.message : 'Retry failed; try again.',
      );
    } finally {
      setRetryingId(null);
    }
  }

  async function openPreview(type: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/admin/notifications/preview/${type}`,
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      setPreview((await res.json()) as PreviewPayload);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load preview.',
      );
    }
  }

  return (
    <div className="space-y-6">
      <SmtpCard initial={initialSmtp} />

      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span className="text-xs text-danger" role="alert">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          icon={<Clock className="h-4 w-4" />}
          label="Queue depth"
          value={stats.queueDepth.toLocaleString()}
          tone={stats.queueDepth > 100 ? 'warn' : 'normal'}
          help="Queued + sending"
        />
        <Metric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Sent (24h)"
          value={stats.sentLast24h.toLocaleString()}
          tone="normal"
        />
        <Metric
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Failed (24h)"
          value={stats.failedLast24h.toLocaleString()}
          tone={stats.failedLast24h > 0 ? 'warn' : 'normal'}
          help={
            stats.failedTotal > stats.failedLast24h
              ? `${stats.failedTotal} total since launch`
              : undefined
          }
        />
        <Metric
          icon={<Clock className="h-4 w-4" />}
          label="Avg latency"
          value={
            stats.avgLatencyMs === null
              ? '-'
              : formatLatency(stats.avgLatencyMs)
          }
          tone="normal"
          help="Create -> sent (24h)"
        />
      </div>

      <DefaultsCard
        initial={initialDefaults}
        statsByType={stats.byType}
        onPreview={(type) => void openPreview(type)}
      />

      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Recent activity
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">
            No notifications yet. Once the platform fires a trigger,
            rows will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="pb-1 text-left font-medium">Type</th>
                  <th className="pb-1 text-left font-medium">Address</th>
                  <th className="pb-1 text-left font-medium">Status</th>
                  <th className="pb-1 text-left font-medium">Created</th>
                  <th className="pb-1 text-left font-medium">Sent</th>
                  <th className="pb-1 text-left font-medium">Attempts</th>
                  <th className="pb-1 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => {
                  const failed = row.status === 'failed';
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="py-1.5 align-top text-ink-1">{row.type}</td>
                      <td className="py-1.5 align-top">{row.address}</td>
                      <td className="py-1.5 align-top">
                        <StatusBadge status={row.status} />
                        {failed && row.lastError ? (
                          <p
                            className="mt-0.5 max-w-xs truncate text-[11px] text-amber-800"
                            title={row.lastError}
                          >
                            {row.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {formatRel(row.createdAt)}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {row.sentAt ? formatRel(row.sentAt) : '-'}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {row.attempts}
                      </td>
                      <td className="py-1.5 text-right align-top">
                        {failed ? (
                          <button
                            type="button"
                            disabled={retryingId === row.id}
                            onClick={() => void retry(row.id)}
                            className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                          >
                            {retryingId === row.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCw className="h-3 w-3" />
                            )}
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {preview ? (
        <PreviewModal preview={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}

// ---- SMTP card ---------------------------------------------------

function SmtpCard({ initial }: { initial: SmtpState }) {
  const [form, setForm] = useState<SmtpState & { password: string }>({
    ...initial,
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [msg, setMsg] = useState<
    { kind: 'ok' | 'warn' | 'err'; text: string } | null
  >(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled: form.enabled,
        host: form.host,
        port: form.port,
        secure: form.secure,
        fromAddress: form.fromAddress,
        fromDisplayName: form.fromDisplayName,
        user: form.user,
      };
      if (form.password.length > 0) body.password = form.password;
      const res = await fetch('/api/portal/admin/notifications/smtp', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const fresh = (await res.json()) as SmtpState;
      setForm({ ...fresh, password: '' });
      // The DB save + worker-transport reload always succeeded if
      // we got here. The realm sync to Keycloak (for invite /
      // forgot-password / verify-email) may have failed
      // separately; surface that as an amber warning rather than
      // a green success so the admin knows realm emails won't
      // route through the new SMTP until they fix the underlying
      // issue (#139).
      if (fresh.realmSyncWarning) {
        setMsg({
          kind: 'warn',
          text: `SMTP saved, but Keycloak realm sync failed: ${fresh.realmSyncWarning}`,
        });
      } else {
        setMsg({
          kind: 'ok',
          text: 'Saved. Worker will use new SMTP on next send.',
        });
      }
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Save failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!testTo.includes('@')) {
      setMsg({ kind: 'err', text: 'Enter a valid email address to test.' });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const config: Record<string, unknown> = {
        enabled: form.enabled,
        host: form.host,
        port: form.port,
        secure: form.secure,
        fromAddress: form.fromAddress,
        fromDisplayName: form.fromDisplayName,
        user: form.user,
      };
      if (form.password.length > 0) config.password = form.password;
      const res = await fetch('/api/portal/admin/notifications/smtp/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: testTo, config }),
      });
      const out = (await res.json()) as { ok: boolean; error?: string };
      if (out.ok) {
        setMsg({ kind: 'ok', text: `Test sent to ${testTo}.` });
      } else {
        setMsg({
          kind: 'err',
          text: out.error ?? 'Test failed without a clear error.',
        });
      }
    } catch (err) {
      setMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Test failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <header className="mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-medium tracking-tight">SMTP</h2>
        {form.host ? (
          <span
            className={`ml-2 inline-flex rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              form.enabled
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-surface-2 text-muted'
            }`}
          >
            {form.enabled ? 'enabled' : 'paused'}
          </span>
        ) : (
          <span className="ml-2 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
            not configured
          </span>
        )}
      </header>
      <p className="mb-3 text-xs text-muted">
        Same SMTP relay drives product notifications + Keycloak invite
        / password-reset emails. Save here and the realm sync runs
        automatically.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Host" hint="e.g. smtp.example.org">
          <input
            type="text"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Port">
          <input
            type="number"
            value={form.port}
            onChange={(e) =>
              setForm({ ...form, port: Number(e.target.value) || 0 })
            }
            className={inputClass}
          />
        </Field>
        <Field label="From address" hint="appears in the From header">
          <input
            type="email"
            value={form.fromAddress}
            onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="From display name">
          <input
            type="text"
            value={form.fromDisplayName}
            onChange={(e) =>
              setForm({ ...form, fromDisplayName: e.target.value })
            }
            className={inputClass}
          />
        </Field>
        <Field label="Username" hint="leave blank for unauthenticated relay">
          <input
            type="text"
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field
          label="Password"
          hint={
            form.hasPassword && form.password.length === 0
              ? 'A password is stored. Type to replace.'
              : 'Stored encrypted at rest.'
          }
        >
          <div className="flex h-9 items-stretch">
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) =>
                setForm({ ...form, password: e.target.value })
              }
              placeholder={
                form.hasPassword ? '(unchanged)' : 'enter password'
              }
              className={`${inputClass} flex-1 rounded-r-none`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="rounded-r-md border border-l-0 border-border bg-surface-2 px-2 text-xs text-muted hover:text-ink-0"
            >
              {showPassword ? 'hide' : 'show'}
            </button>
          </div>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.secure}
            onChange={(e) => setForm({ ...form, secure: e.target.checked })}
          />
          <span>SSL / TLS on connect (port 465)</span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save
        </button>
        <div className="ml-auto flex items-end gap-2">
          <Field label="Send test to">
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className={`${inputClass} w-56`}
            />
          </Field>
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send test
          </button>
        </div>
      </div>
      {msg ? (
        <p
          className={`mt-2 text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-700'
              : msg.kind === 'warn'
                ? 'text-amber-700'
                : 'text-danger'
          }`}
        >
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}

// ---- Defaults card -----------------------------------------------

function DefaultsCard({
  initial,
  statsByType,
  onPreview,
}: {
  initial: DefaultsRow[];
  statsByType: Stats['byType'];
  onPreview: (type: string) => void;
}) {
  const [rows, setRows] = useState<DefaultsRow[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const statsLookup = new Map(statsByType.map((s) => [s.type, s] as const));

  async function setOverride(row: DefaultsRow, enabled: boolean) {
    const key = `${row.type}|${row.channel}`;
    setBusy(key);
    const prev = rows;
    const newIsOverride = enabled !== row.codeDefault;
    setRows((cur) =>
      cur.map((r) =>
        r.type === row.type && r.channel === row.channel
          ? { ...r, effective: enabled, isOverride: newIsOverride }
          : r,
      ),
    );
    try {
      const res = await fetch('/api/portal/admin/notifications/defaults', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: row.type,
          channel: row.channel,
          enabled,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } catch {
      setRows(prev);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
        Notification types
      </h2>
      <table className="min-w-full text-xs">
        <thead className="text-muted">
          <tr>
            <th className="pb-1 text-left font-medium">Type</th>
            <th className="pb-1 text-right font-medium">Queued</th>
            <th className="pb-1 text-right font-medium">Sent</th>
            <th className="pb-1 text-right font-medium">Failed</th>
            <th className="pb-1 text-right font-medium">Default</th>
            <th className="pb-1 text-right font-medium">Preview</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const s = statsLookup.get(row.type);
            const key = `${row.type}|${row.channel}`;
            return (
              <tr key={key} className="border-t border-border">
                <td className="py-1.5 text-ink-1">
                  {row.label}
                  {row.isOverride ? (
                    <span className="ml-1.5 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
                      override
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {(s?.queued ?? 0).toLocaleString()}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {(s?.sent ?? 0).toLocaleString()}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums ${
                    (s?.failed ?? 0) > 0 ? 'text-amber-700' : ''
                  }`}
                >
                  {(s?.failed ?? 0).toLocaleString()}
                </td>
                <td className="py-1.5 text-right">
                  <label className="inline-flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={row.effective}
                      disabled={busy === key}
                      onChange={(e) =>
                        void setOverride(row, e.target.checked)
                      }
                    />
                    <span>{row.effective ? 'on' : 'off'}</span>
                  </label>
                </td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => onPreview(row.type)}
                    className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] font-medium text-ink-1 hover:bg-surface-2"
                  >
                    <Eye className="h-3 w-3" />
                    Preview
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted">
        Off here mutes the type platform-wide for users who haven&apos;t
        explicitly opted in. Per-user opt-ins still win.
      </p>
    </section>
  );
}

// ---- Preview modal -----------------------------------------------

function PreviewModal({
  preview,
  onClose,
}: {
  preview: PreviewPayload;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-surface-1 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">
              Preview
            </p>
            <p className="text-sm font-medium text-ink-0">{preview.label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-surface-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3 text-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted">
              Subject
            </p>
            <p className="mt-0.5 text-sm text-ink-0">{preview.subject}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted">
              HTML
            </p>
            <div
              className="mt-0.5 max-h-80 overflow-auto rounded border border-border bg-surface-0 p-3 text-sm"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          </div>
          <details>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted">
              Plain-text fallback
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-0 p-3 text-[11px] text-ink-1">
              {preview.text}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

// ---- Shared bits -------------------------------------------------

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </label>
  );
}

function Metric({
  icon,
  label,
  value,
  tone,
  help,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'normal' | 'warn';
  help?: string | undefined;
}) {
  return (
    <div
      className={`rounded-lg border bg-surface-1 p-4 shadow-card ${
        tone === 'warn' ? 'border-amber-300' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-0">
        {value}
      </p>
      {help ? <p className="mt-0.5 text-[11px] text-muted">{help}</p> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: RecentRow['status'] }) {
  const tone =
    status === 'sent'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'failed'
        ? 'bg-amber-100 text-amber-900'
        : status === 'sending'
          ? 'bg-sky-100 text-sky-800'
          : 'bg-surface-2 text-muted';
  return (
    <span
      className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}
    >
      {status}
    </span>
  );
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleString();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
