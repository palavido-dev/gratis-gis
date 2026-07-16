// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  Mail,
  Pencil,
  RefreshCcw,
  RotateCcw,
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

/** One row from /admin/notifications/templates -- the org's saved
 *  copy overrides for a (type, channel) pair (#229 Phase B). The
 *  initial fetch only includes types that have an override; types
 *  without one are inferred by absence in this list. */
export interface TemplateOverrideRow {
  type: string;
  channel: 'email';
  isOverride: true;
  updatedAt: string | null;
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
  initialTemplateOverrides: TemplateOverrideRow[];
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
  initialTemplateOverrides,
}: Props) {
  const [stats, setStats] = useState<Stats>(initialStats);
  const [recent, setRecent] = useState<RecentRow[]>(initialRecent);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  // Templates editor state (#229 Phase B). The set of overrides
  // lives at the page level so the DefaultsCard's "override"
  // badge stays in sync after a save / reset without a full
  // refresh.
  const [templateOverrides, setTemplateOverrides] = useState<
    TemplateOverrideRow[]
  >(initialTemplateOverrides);
  const [editingType, setEditingType] = useState<{
    type: string;
    label: string;
    channel: 'email';
  } | null>(null);

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
        templateOverrides={templateOverrides}
        onPreview={(type) => void openPreview(type)}
        onCustomize={(row) =>
          setEditingType({
            type: row.type,
            label: row.label,
            channel: row.channel,
          })
        }
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
                            className="mt-0.5 max-w-xs truncate text-[11px] text-warn"
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

      {editingType ? (
        <TemplateEditModal
          type={editingType.type}
          label={editingType.label}
          channel={editingType.channel}
          onClose={() => setEditingType(null)}
          onSaved={(saved) => {
            // Maintain the per-type override badge state when the
            // admin saves or resets a template. Saved -> ensure
            // present; reset -> drop.
            setTemplateOverrides((cur) => {
              const without = cur.filter(
                (r) => !(r.type === editingType.type && r.channel === editingType.channel),
              );
              if (!saved) return without;
              return [
                ...without,
                {
                  type: editingType.type,
                  channel: editingType.channel,
                  isOverride: true as const,
                  updatedAt: new Date().toISOString(),
                },
              ];
            });
          }}
        />
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
                ? 'bg-success/15 text-success'
                : 'bg-surface-2 text-muted'
            }`}
          >
            {form.enabled ? 'enabled' : 'paused'}
          </span>
        ) : (
          <span className="ml-2 inline-flex rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
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
              ? 'text-success'
              : msg.kind === 'warn'
                ? 'text-warn'
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
  templateOverrides,
  onPreview,
  onCustomize,
}: {
  initial: DefaultsRow[];
  statsByType: Stats['byType'];
  templateOverrides: TemplateOverrideRow[];
  onPreview: (type: string) => void;
  onCustomize: (row: DefaultsRow) => void;
}) {
  const [rows, setRows] = useState<DefaultsRow[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const statsLookup = new Map(statsByType.map((s) => [s.type, s] as const));
  // Set of `${type}|${channel}` keys that have a saved per-org
  // template override. Used to badge the row + flip the Customize
  // button affordance from "Customize" to "Edit".
  const templateOverrideKeys = new Set(
    templateOverrides.map((t) => `${t.type}|${t.channel}`),
  );

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
            <th className="pb-1 text-right font-medium">Template</th>
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
                    <span className="ml-1.5 inline-flex rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
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
                    (s?.failed ?? 0) > 0 ? 'text-warn' : ''
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
                  {(() => {
                    const hasOverride = templateOverrideKeys.has(key);
                    return (
                      <button
                        type="button"
                        onClick={() => onCustomize(row)}
                        className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] font-medium text-ink-1 hover:bg-surface-2"
                        title={
                          hasOverride
                            ? 'Editing your saved template'
                            : 'Override the default copy for this org'
                        }
                      >
                        <Pencil className="h-3 w-3" />
                        {hasOverride ? 'Edit' : 'Customize'}
                        {hasOverride ? (
                          <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-warn" />
                        ) : null}
                      </button>
                    );
                  })()}
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
        explicitly opted in. Per-user opt-ins still win. Customize
        rewrites the email body for your org; saved templates
        substitute mustache-style placeholders like {'{{itemTitle}}'}
        and {'{{baseUrl}}'} from the trigger payload.
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

// ---- Template edit modal (#229 Phase B) --------------------------

/**
 * Lets an admin override the per-NotificationType email body for
 * their org. Three textareas (subject, plain-text body, HTML body)
 * with a live preview pane that re-renders against the type's
 * sample payload after a 250ms debounce. Saving upserts the
 * notification_template row; Reset deletes it so the runtime
 * falls back to the hardcoded default in templates.ts.
 *
 * The placeholder grammar is mustache-lite: {{name}} HTML-escapes,
 * {{{name}}} passes through. Both substitute from the payload +
 * { orgLabel, baseUrl } context the runtime carries. The renderer
 * lives server-side (NotificationTemplateService.previewUnsaved)
 * so the preview is a faithful round-trip of what the worker will
 * eventually send.
 */
function TemplateEditModal({
  type,
  label,
  channel,
  onClose,
  onSaved,
}: {
  type: string;
  label: string;
  channel: 'email';
  onClose: () => void;
  /** Called with `true` when the admin clicks Save (a row now
   *  exists), `false` when they click Reset (the override has been
   *  removed). The parent uses this to update the badge in the
   *  per-type table without a full refresh. */
  onSaved: (hasOverride: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [hasOverride, setHasOverride] = useState(false);
  const [defaultPreview, setDefaultPreview] = useState<{
    subject: string;
    text: string;
    html: string;
  } | null>(null);
  // #250: per-type variable manifest, populated from the GET
  // /templates endpoint. Drives the click-to-insert palette so admins
  // don't have to memorize the placeholder names.
  type VariableDescriptor = {
    name: string;
    label: string;
    description?: string;
    example?: string;
    raw?: boolean;
  };
  const [variables, setVariables] = useState<VariableDescriptor[]>([]);
  // #250: ref to the input/textarea that last had focus, so the
  // palette can insert at the caret in whichever field the admin
  // was last editing. We track only the focused element + its
  // selection range; the actual insert reads the live ref off the
  // DOM at click time.
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyHtmlRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyTextRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<
    'subject' | 'bodyHtml' | 'bodyText' | null
  >(null);
  const [preview, setPreview] = useState<{
    subject: string;
    text: string;
    html: string;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial fetch: load the saved override (if any) and the
  // hardcoded default preview so the admin can see what they're
  // diverging from before they start typing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/admin/notifications/templates/${type}/${channel}`,
        );
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const json = (await res.json()) as {
          override: {
            subject: string;
            bodyText: string;
            bodyHtml: string;
            updatedAt: string;
          } | null;
          defaultPreview: { subject: string; text: string; html: string };
          variables?: VariableDescriptor[];
        };
        if (cancelled) return;
        setDefaultPreview(json.defaultPreview);
        setVariables(json.variables ?? []);
        if (json.override) {
          setSubject(json.override.subject);
          setBodyText(json.override.bodyText);
          setBodyHtml(json.override.bodyHtml);
          setHasOverride(true);
          setPreview(null);
        } else {
          // Seed the textareas with the hardcoded default copy so
          // the admin can edit-by-tweak rather than start from
          // blank. We keep `hasOverride` false so the Reset button
          // stays disabled until they Save.
          setSubject(json.defaultPreview.subject);
          setBodyText(json.defaultPreview.text);
          setBodyHtml(json.defaultPreview.html);
          setPreview(json.defaultPreview);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load template.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, channel]);

  /**
   * #250: insert `{{name}}` (or `{{{name}}}` when raw=true) at the
   * caret of whichever input was focused last. The element refs and
   * the `lastFocused` tracker drive the target selection: clicking a
   * palette button blurs the input briefly, so we have to remember
   * which one was active. Falls back to bodyHtml when the admin
   * hasn't focused anything yet (most common starting case for
   * everyone-already-knows-what-they-want flows).
   */
  function insertVariable(v: VariableDescriptor) {
    const placeholder = v.raw ? `{{{${v.name}}}}` : `{{${v.name}}}`;
    const target = lastFocused.current ?? 'bodyHtml';
    if (target === 'subject') {
      const el = subjectRef.current;
      if (!el) return;
      const start = el.selectionStart ?? subject.length;
      const end = el.selectionEnd ?? subject.length;
      const next = subject.slice(0, start) + placeholder + subject.slice(end);
      setSubject(next);
      // Restore caret just after the inserted token. Defer to the
      // next tick so React's state-batched re-render runs first.
      window.requestAnimationFrame(() => {
        el.focus();
        const pos = start + placeholder.length;
        el.setSelectionRange(pos, pos);
      });
      schedulePreview();
      return;
    }
    if (target === 'bodyHtml') {
      const el = bodyHtmlRef.current;
      if (!el) return;
      const start = el.selectionStart ?? bodyHtml.length;
      const end = el.selectionEnd ?? bodyHtml.length;
      const next = bodyHtml.slice(0, start) + placeholder + bodyHtml.slice(end);
      setBodyHtml(next);
      window.requestAnimationFrame(() => {
        el.focus();
        const pos = start + placeholder.length;
        el.setSelectionRange(pos, pos);
      });
      schedulePreview();
      return;
    }
    if (target === 'bodyText') {
      const el = bodyTextRef.current;
      if (!el) return;
      const start = el.selectionStart ?? bodyText.length;
      const end = el.selectionEnd ?? bodyText.length;
      const next = bodyText.slice(0, start) + placeholder + bodyText.slice(end);
      setBodyText(next);
      window.requestAnimationFrame(() => {
        el.focus();
        const pos = start + placeholder.length;
        el.setSelectionRange(pos, pos);
      });
      schedulePreview();
      return;
    }
  }

  /**
   * #250: derive a plain-text fallback from the current HTML body so
   * admins don't have to maintain two copies by hand. Strips tags
   * and collapses whitespace; the worker still runs the templates
   * separately so substitution still works on whatever placeholders
   * survived the strip. Best-effort -- complex tables and lists
   * don't survive perfectly, but the result is always better than
   * an empty plain-text body for spam-filter heuristics.
   */
  function derivePlainTextFromHtml() {
    if (typeof document === 'undefined') return;
    // Parse the admin-authored HTML in an inert document via
    // DOMParser instead of assigning to a live element's innerHTML.
    // DOMParser('text/html') doesn't execute scripts and doesn't
    // resolve external resources, which closes the
    // js/xss-through-dom hole CodeQL flagged on the innerHTML form
    // (defense in depth: the only writer is an authenticated org
    // admin, but the parsed-tree variant has no execution side
    // effects either way).
    const parsed = new DOMParser().parseFromString(bodyHtml, 'text/html');
    const tmp = parsed.body;
    // Replace block-ish elements with line breaks so paragraphs
    // don't end up jammed onto one line.
    tmp.querySelectorAll('p, br, li, h1, h2, h3, h4, h5, h6, div').forEach(
      (el) => {
        if (el.tagName === 'BR') {
          el.replaceWith(document.createTextNode('\n'));
          return;
        }
        el.appendChild(document.createTextNode('\n'));
      },
    );
    // List items get a leading bullet for readability.
    tmp.querySelectorAll('li').forEach((el) => {
      el.prepend(document.createTextNode('- '));
    });
    const text = (tmp.textContent ?? '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    setBodyText(text);
    schedulePreview();
  }

  function schedulePreview() {
    if (typeof window === 'undefined') return;
    setPreviewing(true);
    window.clearTimeout((schedulePreview as unknown as { _t?: number })._t);
    (schedulePreview as unknown as { _t?: number })._t = window.setTimeout(
      async () => {
        try {
          const res = await fetch(
            '/api/portal/admin/notifications/templates/preview',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type, subject, bodyText, bodyHtml }),
            },
          );
          if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
          setPreview(
            (await res.json()) as { subject: string; text: string; html: string },
          );
          setErr(null);
        } catch (e) {
          setErr(e instanceof Error ? e.message : 'Preview failed.');
        } finally {
          setPreviewing(false);
        }
      },
      250,
    );
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/portal/admin/notifications/templates/${type}/${channel}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject, bodyText, bodyHtml }),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setHasOverride(true);
      onSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setResetting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/portal/admin/notifications/templates/${type}/${channel}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 204) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      setHasOverride(false);
      onSaved(false);
      // Repopulate textareas with the hardcoded default so the
      // admin can keep iterating from a known baseline.
      if (defaultPreview) {
        setSubject(defaultPreview.subject);
        setBodyText(defaultPreview.text);
        setBodyHtml(defaultPreview.html);
        setPreview(defaultPreview);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Reset failed.');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-surface-1 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">
              Edit template ({channel})
            </p>
            <p className="text-sm font-medium text-ink-0">{label}</p>
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

        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading template...
          </div>
        ) : loadError ? (
          <div className="px-4 py-6 text-xs text-danger">{loadError}</div>
        ) : (
          <div className="grid flex-1 grid-cols-1 gap-4 overflow-auto px-4 py-4 lg:grid-cols-2">
            <div className="space-y-3">
              {/* #250: variable palette. Click any variable to insert
                  it at the caret of the input/textarea that was last
                  focused. Avoids having to memorize {{itemTitle}} vs
                  {{itemId}} -- the substitution names are visible and
                  one tap drops them in. Standard ctx vars (orgLabel,
                  baseUrl) follow per-type vars so the most-relevant
                  ones sit closest to the inputs. */}
              {variables.length > 0 ? (
                <div className="rounded-md border border-border bg-surface-0 p-2">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Insert variable
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {variables.map((v) => (
                      <button
                        key={v.name}
                        type="button"
                        onClick={() => insertVariable(v)}
                        title={
                          (v.description ? `${v.description}\n\n` : '') +
                          (v.example ? `Example: ${v.example}` : '')
                        }
                        className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[10px] text-ink-1 hover:bg-surface-2"
                      >
                        <span className="font-mono text-muted">
                          {`{{${v.name}}}`}
                        </span>
                        <span>{v.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <Field
                label="Subject"
                hint="Mustache-lite. Use the variable buttons above to insert."
              >
                <input
                  ref={subjectRef}
                  type="text"
                  value={subject}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    schedulePreview();
                  }}
                  onFocus={() => {
                    lastFocused.current = 'subject';
                  }}
                  className={inputClass}
                />
              </Field>

              <Field
                label="HTML body"
                hint="{{name}} escapes, {{{name}}} passes raw HTML."
              >
                <textarea
                  ref={bodyHtmlRef}
                  rows={10}
                  value={bodyHtml}
                  onChange={(e) => {
                    setBodyHtml(e.target.value);
                    schedulePreview();
                  }}
                  onFocus={() => {
                    lastFocused.current = 'bodyHtml';
                  }}
                  className="w-full rounded-md border border-border bg-surface-1 p-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </Field>

              <Field
                label="Plain-text body"
                hint="Sent as the multipart/alternative fallback."
              >
                <div className="space-y-1">
                  <textarea
                    ref={bodyTextRef}
                    rows={6}
                    value={bodyText}
                    onChange={(e) => {
                      setBodyText(e.target.value);
                      schedulePreview();
                    }}
                    onFocus={() => {
                      lastFocused.current = 'bodyText';
                    }}
                    className="w-full rounded-md border border-border bg-surface-1 p-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <button
                    type="button"
                    onClick={derivePlainTextFromHtml}
                    className="text-[10px] text-accent hover:underline"
                  >
                    Generate from HTML body
                  </button>
                </div>
              </Field>

              {err ? (
                <p className="text-xs text-danger" role="alert">
                  {err}
                </p>
              ) : null}
            </div>

            <div className="space-y-3">
              <p className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
                Live preview
                {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              </p>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted">
                  Subject
                </p>
                <p className="mt-0.5 text-sm text-ink-0">
                  {preview?.subject ?? '...'}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted">
                  HTML
                </p>
                <div
                  className="mt-0.5 max-h-72 overflow-auto rounded border border-border bg-surface-0 p-3 text-sm"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: preview?.html ?? '' }}
                />
              </div>
              <details>
                <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted">
                  Plain-text fallback
                </summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-0 p-3 text-[11px] text-ink-1">
                  {preview?.text ?? ''}
                </pre>
              </details>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            disabled={!hasOverride || resetting}
            onClick={() => void reset()}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {resetting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Reset to default
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save override
            </button>
          </div>
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
        tone === 'warn' ? 'border-warn/40' : 'border-border'
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
      ? 'bg-success/15 text-success'
      : status === 'failed'
        ? 'bg-warn/15 text-warn'
        : status === 'sending'
          ? 'bg-info/15 text-info'
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
