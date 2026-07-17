// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #158 PostgreSQL + PostGIS connection wizard.
 *
 * Inline builder for the wizard's postgis_live path. The author
 * fills in host / port / database / role / password, clicks
 * "Test connection" to verify, then "Save" — the backend
 * single-shot `/postgis-live/create` endpoint creates the item,
 * stores the password as a credential, and runs the probe to
 * populate the table list.
 *
 * No UUIDs to copy, no raw JSON. The author types what they'd
 * type into a psql command line and lands on a working service
 * item.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Plug, Save } from 'lucide-react';

interface Props {
  /** Title chosen on the previous wizard step. */
  title: string;
  /** Optional description chosen on the previous step. */
  description: string;
  /** Disables the save button until the previous wizard step is
   *  valid (title non-empty etc.). */
  canSave: boolean;
}

interface TestResult {
  ok: true;
  postgisVersion: string;
}
interface TestError {
  ok: false;
  error: string;
}

export function PostgisConnectionBuilder({
  title,
  description,
  canSave,
}: Props) {
  const router = useRouter();
  const [host, setHost] = useState('');
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState('');
  const [role, setRole] = useState('');
  const [password, setPassword] = useState('');
  const [defaultSchema, setDefaultSchema] = useState('public');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | TestError | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/portal/postgis-live/test-connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, port, database, role, password }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setTestResult({ ok: false, error: body || `${res.status}` });
        return;
      }
      const json = (await res.json()) as TestResult | TestError;
      setTestResult(json);
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/portal/postgis-live/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          host,
          port,
          database,
          role,
          password,
          defaultSchema: defaultSchema || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `${res.status}`);
      }
      const item = (await res.json()) as { id: string };
      router.push(`/items/${item.id}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const filled =
    host.length > 0 && database.length > 0 && role.length > 0;

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">
        Connect to PostgreSQL + PostGIS
      </h2>
      <p className="mb-3 text-xs text-muted">
        We&rsquo;ll connect to your PostGIS database to read tables on
        demand. The password is stored encrypted and never sent to
        the browser after this form.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">
          Host
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="db.internal"
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            autoComplete="off"
          />
        </label>
        <label className="text-xs">
          Port
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 5432)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
          />
        </label>
        <label className="text-xs">
          Database
          <input
            type="text"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="myorg"
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            autoComplete="off"
          />
        </label>
        <label className="text-xs">
          Role / username
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="readonly_role"
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            autoComplete="off"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            autoComplete="new-password"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          Default schema
          <input
            type="text"
            value={defaultSchema}
            onChange={(e) => setDefaultSchema(e.target.value)}
            placeholder="public"
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            autoComplete="off"
          />
          <span className="mt-0.5 inline-block text-2xs text-muted">
            Tables in this schema show up in the layer picker by
            default. Other schemas stay reachable via the detail
            page.
          </span>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={test}
          disabled={!filled || testing}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plug className="h-3.5 w-3.5" />
          )}
          Test connection
        </button>
        {testResult?.ok ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            PostGIS {testResult.postgisVersion}
          </span>
        ) : null}
        {testResult && !testResult.ok ? (
          <span className="text-xs text-danger" role="alert">
            {testResult.error}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={save}
          disabled={!filled || !canSave || saving || testResult?.ok !== true}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save connection
        </button>
        {!testResult?.ok ? (
          <span className="text-2xs text-muted">
            Run "Test connection" first.
          </span>
        ) : null}
        {saveError ? (
          <p role="alert" className="basis-full text-xs text-danger">
            {saveError}
          </p>
        ) : null}
      </div>
    </section>
  );
}
