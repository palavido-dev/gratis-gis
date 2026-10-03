// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  Search,
  Upload,
} from 'lucide-react';
import {
  ORG_URL_STORAGE_KEY,
  SHARING_BASE_STORAGE_KEY,
  STATE_STORAGE_KEY,
  TOKEN_CHANNEL_NAME,
} from './oauth-storage-keys';

interface AgoConnection {
  id: string;
  orgUrl: string;
  orgHost: string;
  displayName: string;
  clientId: string;
  createdAt: string;
  createdById: string;
}

interface DryRunItem {
  agoId: string;
  agoType: string;
  title: string;
  folderTitle: string;
  willImport: boolean;
  targetType: string | null;
  reason?: string;
  serviceUrl?: string;
  access?: string;
}

interface DryRunReport {
  portal: { url: string; username: string };
  generatedAt: string;
  counts: {
    foldersTotal: number;
    itemsTotal: number;
    itemsToImport: number;
    itemsToSkip: number;
    byTargetType: Record<string, number>;
    byAgoType: Record<string, number>;
    byAccess?: Record<string, number>;
  };
  folders: Array<{ id: string; title: string }>;
  items: DryRunItem[];
  warnings: Array<{ severity: 'info' | 'warn'; message: string }>;
}

interface ImportResult {
  agoId: string;
  agoType: string;
  agoTitle: string;
  status: 'created' | 'failed' | 'skipped';
  portalItemId?: string;
  portalItemType?: string;
  warnings: string[];
  error?: string;
}

interface ImportedFolder {
  agoFolderId: string;
  title: string;
  portalItemId: string;
  childCount: number;
}

interface ImportReport {
  total: number;
  created: number;
  failed: number;
  skipped: number;
  results: ImportResult[];
  folders: ImportedFolder[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface SessionState {
  token: string;
  sharingRestBase: string;
  connectionDisplayName: string;
  expiresAtMs: number;
}

/** Snapshot of one in-flight async ImportJob row (#55). Mirrors
 *  the server's AgoImportJobDto shape so the controller's polling
 *  response can be assigned in directly. */
interface AgoImportJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  total: number;
  done: number;
  currentItem: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: ImportReport | null;
}

/** Locally-tracked progress state for the in-flight job. Trimmed
 *  to the bits the progress bar + status line render so a tiny
 *  setState doesn't unnecessarily re-render the rest of the page. */
interface JobProgress {
  done: number;
  total: number;
  currentItem: string | null;
  status: AgoImportJob['status'];
}

const POLL_INTERVAL_MS = 1000;

/** Tiny sleep helper used by the job polling loop. Inlined so we
 *  don't add a util import for a one-liner. */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function FromAgoView() {
  const [conns, setConns] = useState<AgoConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [preview, setPreview] = useState<DryRunReport | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'auth' | 'preview' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  // Per-item opt-out: AGO ids the operator has unchecked in the
  // preview. Defaults to empty -> every classifier-importable row
  // imports. Skipped (classifier-unsupported) rows aren't toggleable;
  // they're already willImport=false on the dry-run row.
  const [excludedAgoIds, setExcludedAgoIds] = useState<Set<string>>(
    new Set(),
  );
  // Async ImportJob (#55) state. jobProgress is null when no job
  // is in-flight; once a run starts the polling loop bumps it on
  // every status response. activeJobIdRef survives across renders
  // so the cancel button + the polling loop can both reach the
  // current job id without a stale-closure problem.
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  // Ref for the import-results section so we can scroll it into
  // view the moment the job completes (the import-results
  // section sits below the preview, which can be a long table).
  const importResultsRef = useRef<HTMLElement | null>(null);
  // AGO-type group collapse state for the per-item preview table.
  // Default-populated whenever a fresh preview lands: any AGO
  // type with zero importable rows (Dashboard, StoryMap, Form,
  // GeoJSON when there's no mapping, etc.) starts collapsed so
  // the table opens to just the actionable rows. The user can
  // expand a skipped group to inspect what's being left behind.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  // Reset the exclusion set whenever a fresh preview lands so a
  // re-preview doesn't carry over stale opt-outs.
  useEffect(() => {
    setExcludedAgoIds(new Set());
  }, [preview]);

  // Re-seed the collapse set on a fresh preview: any AGO type
  // group whose rows are all classifier-skipped collapses by
  // default. Importable groups stay expanded so the actionable
  // rows are visible without an extra click.
  useEffect(() => {
    if (!preview) return;
    const byType = new Map<string, DryRunItem[]>();
    for (const row of preview.items) {
      const arr = byType.get(row.agoType) ?? [];
      arr.push(row);
      byType.set(row.agoType, arr);
    }
    const collapsed = new Set<string>();
    for (const [type, rows] of byType) {
      const anyImportable = rows.some((r) => r.willImport && r.targetType);
      if (!anyImportable) collapsed.add(type);
    }
    setCollapsedGroups(collapsed);
  }, [preview]);

  // Load the connections list once on mount.
  useEffect(() => {
    void (async () => {
      try {
        const resp = await fetch(
          '/api/portal/admin/import-ago/connections',
        );
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
        }
        const list = (await resp.json()) as AgoConnection[];
        setConns(list);
        if (list.length > 0 && !selectedId) setSelectedId(list[0]!.id);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
    // selectedId intentionally omitted from deps: we only auto-pick
    // on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OAuth popup token handoff via BroadcastChannel.
  //
  // The previous shape used window.opener.postMessage; that
  // breaks under modern COOP on the cross-origin hop through AGO
  // (window.opener becomes null in the popup after the redirect
  // returns). BroadcastChannel is same-origin-only by spec, so
  // security stays intact, and it survives the cross-origin
  // navigation that severs opener.
  //
  // A window.addEventListener('message') fallback is kept for the
  // happy path where opener does survive (some browsers) -- both
  // paths produce the same effect so a duplicate delivery is a
  // no-op.
  useEffect(() => {
    function handlePayload(data: {
      type?: string;
      token?: string;
      state?: string;
      expiresIn?: number;
      receivedAt?: number;
    } | null) {
      if (!data || data.type !== 'gratisgis:ago-oauth-token') return;
      if (!data.token) {
        setError('OAuth popup returned no token.');
        setBusy(null);
        return;
      }
      // Idempotency: a popup that fires both the BroadcastChannel
      // and the postMessage paths should not double-set state. If
      // we already have a session, ignore the second delivery.
      if (session) return;
      const sharingRestBase =
        window.sessionStorage.getItem(SHARING_BASE_STORAGE_KEY) ?? '';
      const displayName =
        window.sessionStorage.getItem(ORG_URL_STORAGE_KEY) ?? '';
      const expiresIn = Number(data.expiresIn) || 3600;
      const receivedAt = Number(data.receivedAt) || Date.now();
      setSession({
        token: data.token,
        sharingRestBase,
        connectionDisplayName: displayName,
        expiresAtMs: receivedAt + expiresIn * 1000,
      });
      setBusy(null);
      setError(null);
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;
    }

    // Primary path: BroadcastChannel. Same-origin only.
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(TOKEN_CHANNEL_NAME);
      channel.addEventListener(
        'message',
        (event: MessageEvent<unknown>) => {
          handlePayload(
            event.data as Parameters<typeof handlePayload>[0],
          );
        },
      );
    } catch {
      // Ancient browser without BroadcastChannel; the
      // postMessage fallback below still gets a chance.
    }

    // Fallback path: window.opener.postMessage. Only delivers
    // when COOP didn't sever the opener relationship (still true
    // on same-origin popups in many browsers).
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin) return;
      handlePayload(event.data as Parameters<typeof handlePayload>[0]);
    }
    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [session]);

  async function signIn() {
    if (!selectedId) {
      setError('Pick a connection first.');
      return;
    }
    setBusy('auth');
    setError(null);
    setPreview(null);
    setImportReport(null);
    try {
      const redirectUri = `${window.location.origin}/admin/migrations/from-ago/oauth-callback`;
      const resp = await fetch('/api/portal/admin/import-ago/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedId, redirectUri }),
      });
      if (!resp.ok) {
        throw new Error(
          `OAuth start failed: HTTP ${resp.status} ${await resp.text()}`,
        );
      }
      const data = (await resp.json()) as {
        authorizeUrl: string;
        sharingRestBase: string;
        state: string;
        connection: AgoConnection;
      };
      window.sessionStorage.setItem(STATE_STORAGE_KEY, data.state);
      window.sessionStorage.setItem(
        SHARING_BASE_STORAGE_KEY,
        data.sharingRestBase,
      );
      window.sessionStorage.setItem(
        ORG_URL_STORAGE_KEY,
        data.connection.displayName,
      );

      const w = 540;
      const h = 700;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        data.authorizeUrl,
        'gratisgis-ago-oauth',
        `popup=1,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`,
      );
      if (!popup) {
        throw new Error(
          'Popup blocked. Allow popups for this site and try again.',
        );
      }
      popupRef.current = popup;
      // No popup.closed polling here: under COOP (especially in
      // Edge / Chrome) `popup.closed` returns true the instant the
      // popup navigates cross-origin to AGO, well before the user
      // has signed in. The token handoff via BroadcastChannel is
      // the authoritative success signal; for the "user closed
      // the popup without signing in" path, the long-timeout
      // safety net below + the manual Cancel button reset busy
      // state without false positives.
      window.setTimeout(
        () => {
          if (popupRef.current === popup) {
            setBusy(null);
            setError(
              'Sign-in did not complete within 10 minutes. Try again.',
            );
            popupRef.current = null;
          }
        },
        10 * 60 * 1000,
      );
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Manual cancel for the sign-in popup. The popup itself stays
   *  open (closing it under COOP requires the popup's own context),
   *  but the opener stops waiting and the user can dismiss the
   *  popup themselves. */
  function cancelSignIn() {
    if (busy !== 'auth') return;
    setBusy(null);
    setError(null);
    // Best-effort: close the popup if we still hold a reference
    // the browser will honour. Under strict COOP this no-ops.
    try {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    } catch {
      /* COOP blocked the close; user closes the popup manually */
    }
    popupRef.current = null;
  }

  function signOut() {
    setSession(null);
    setPreview(null);
    setImportReport(null);
    setError(null);
    window.sessionStorage.removeItem(SHARING_BASE_STORAGE_KEY);
    window.sessionStorage.removeItem(ORG_URL_STORAGE_KEY);
  }

  async function runPreview() {
    if (!session) return;
    setBusy('preview');
    setError(null);
    setImportReport(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portalUrl: session.sharingRestBase,
          token: session.token,
        }),
      });
      if (!resp.ok) {
        throw new Error(
          `Preview failed: HTTP ${resp.status} ${await resp.text()}`,
        );
      }
      setPreview((await resp.json()) as DryRunReport);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!preview || !session) return;
    setBusy('run');
    setError(null);
    setJobProgress(null);
    try {
      // Apply the operator's per-item opt-outs by clearing
      // willImport on each excluded row. The backend already
      // honours willImport=false, so this is a pure client-side
      // mutation of the report we're about to send.
      const effective: DryRunReport = {
        ...preview,
        items: preview.items.map((row) =>
          excludedAgoIds.has(row.agoId)
            ? { ...row, willImport: false }
            : row,
        ),
      };
      // Kick off the async job. The single sync POST /run is
      // still available but the wizard always uses the job path
      // so a 30-minute hosted-FS import doesn't hold a long-lived
      // HTTP connection. /run/start returns immediately with the
      // job id; we then poll /run/:id until the status flips to
      // a terminal value.
      const startResp = await fetch(
        '/api/portal/admin/import-ago/run/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            portalUrl: session.sharingRestBase,
            token: session.token,
            report: effective,
          }),
        },
      );
      if (!startResp.ok) {
        throw new Error(
          `Import failed: HTTP ${startResp.status} ${await startResp.text()}`,
        );
      }
      const { id: jobId } = (await startResp.json()) as { id: string };
      activeJobIdRef.current = jobId;
      // Poll every second until we land on a terminal state. The
      // server-side runner writes done + currentItem on every item
      // boundary so the progress bar updates smoothly.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(POLL_INTERVAL_MS);
        if (activeJobIdRef.current !== jobId) {
          // The user navigated away or started a new job; stop
          // polling this one rather than racing the UI state.
          return;
        }
        const statusResp = await fetch(
          `/api/portal/admin/import-ago/run/${encodeURIComponent(jobId)}`,
        );
        if (!statusResp.ok) {
          throw new Error(
            `Job polling failed: HTTP ${statusResp.status} ${await statusResp.text()}`,
          );
        }
        const job = (await statusResp.json()) as AgoImportJob;
        setJobProgress({
          done: job.done,
          total: job.total,
          currentItem: job.currentItem,
          status: job.status,
        });
        if (
          job.status === 'succeeded' ||
          job.status === 'failed' ||
          job.status === 'cancelled'
        ) {
          if (job.status === 'succeeded' && job.report) {
            setImportReport(job.report);
            // Clear the progress banner so the results table is
            // the next thing the user sees; without this the
            // progress section + the import-results section
            // stack and the "Run Import" button reappearing
            // looks like nothing happened.
            setJobProgress(null);
            // Scroll the results into view -- on a long preview
            // table the results section is well below the
            // fold, and the user reported the import "finishing
            // with no visual indication."
            requestAnimationFrame(() => {
              importResultsRef.current?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
              });
            });
          } else if (job.status === 'failed') {
            setJobProgress(null);
            throw new Error(
              `Import failed: ${job.errorMessage ?? 'unknown error'}`,
            );
          } else if (job.status === 'cancelled') {
            setError('Import cancelled.');
          }
          activeJobIdRef.current = null;
          return;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function cancelImport() {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    try {
      await fetch(
        `/api/portal/admin/import-ago/run/${encodeURIComponent(jobId)}/cancel`,
        { method: 'POST' },
      );
    } catch (e) {
      setError(`Cancel failed: ${(e as Error).message}`);
    }
  }

  /** True when the row is something the operator can toggle.
   *  Classifier-unsupported rows (Dashboard, Form, StoryMap, etc.)
   *  are not toggleable because there's no path to import them
   *  even if the operator opts in. */
  function isToggleable(row: DryRunItem): boolean {
    return Boolean(row.willImport && row.targetType);
  }

  function toggleRow(agoId: string) {
    setExcludedAgoIds((prev) => {
      const next = new Set(prev);
      if (next.has(agoId)) next.delete(agoId);
      else next.add(agoId);
      return next;
    });
  }

  function selectAllImportable() {
    setExcludedAgoIds(new Set());
  }

  function deselectAllImportable() {
    if (!preview) return;
    const all = new Set<string>();
    for (const row of preview.items) {
      if (isToggleable(row)) all.add(row.agoId);
    }
    setExcludedAgoIds(all);
  }

  /** Effective "will import" row check after applying the
   *  operator's opt-outs. */
  function willActuallyImport(row: DryRunItem): boolean {
    if (!isToggleable(row)) return false;
    return !excludedAgoIds.has(row.agoId);
  }

  function toggleGroup(type: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  /** Group preview rows by AGO type for the collapsible table.
   *
   * Sort order is two-tier: importable types first (so the
   * actionable bit of the migration is what the operator sees
   * by default), then unsupported types alphabetically. Within
   * each group rows sort by folder, then title -- the dry-run
   * returns rows in walk order which doesn't help when scanning
   * a large org. */
  const groupedItems = useMemo(() => {
    if (!preview) return [];
    const byType = new Map<string, DryRunItem[]>();
    for (const row of preview.items) {
      const arr = byType.get(row.agoType) ?? [];
      arr.push(row);
      byType.set(row.agoType, arr);
    }
    const list = Array.from(byType, ([type, rows]) => {
      rows.sort((a, b) => {
        const af = a.folderTitle ?? '';
        const bf = b.folderTitle ?? '';
        if (af !== bf) return af.localeCompare(bf);
        return a.title.localeCompare(b.title);
      });
      const importableCount = rows.filter(
        (r) => r.willImport && r.targetType,
      ).length;
      return { type, rows, importableCount };
    });
    list.sort((a, b) => {
      if (
        (a.importableCount > 0) !==
        (b.importableCount > 0)
      ) {
        return a.importableCount > 0 ? -1 : 1;
      }
      return a.type.localeCompare(b.type);
    });
    return list;
  }, [preview]);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
        {session ? (
          <SignedInPanel
            session={session}
            onSignOut={signOut}
            busy={busy}
            onPreview={runPreview}
            onRun={runImport}
            canRun={!!preview}
          />
        ) : (
          <PickConnectionPanel
            conns={conns}
            loadError={loadError}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSignIn={signIn}
            onCancelSignIn={cancelSignIn}
            busy={busy}
          />
        )}
        {error && (
          <p className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </section>

      {preview && (
        <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
          <h2 className="text-base font-semibold">Preview</h2>
          <p className="mt-1 text-xs text-muted">
            Walked {preview.counts.itemsTotal} item(s) across{' '}
            {preview.counts.foldersTotal} folder(s) belonging to{' '}
            <span className="font-mono">{preview.portal.username}</span>.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Counter
              label="Will import"
              value={preview.items.filter((r) => willActuallyImport(r)).length}
              tone="ok"
            />
            <Counter
              label="Will skip"
              value={
                preview.items.length -
                preview.items.filter((r) => willActuallyImport(r)).length
              }
              tone="warn"
            />
            <Counter
              label="Folders"
              value={preview.counts.foldersTotal}
              tone="neutral"
            />
          </div>
          {preview.warnings.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {preview.warnings.map((w, i) => (
                <li
                  key={i}
                  className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                    w.severity === 'warn'
                      ? 'border-warning/30 bg-warning/5 text-warning'
                      : 'border-border bg-surface-0 text-ink-1'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-0">
                Per-item detail
              </h3>
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={selectAllImportable}
                  className="rounded-md border border-border bg-surface-0 px-2 py-1 font-medium hover:bg-surface-2"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={deselectAllImportable}
                  className="rounded-md border border-border bg-surface-0 px-2 py-1 font-medium hover:bg-surface-2"
                >
                  Deselect all
                </button>
              </div>
            </div>
            <p className="mb-2 text-xs text-muted">
              Uncheck individual items to skip them. Unsupported types
              (Dashboard, StoryMap, Form, etc.) can&apos;t be toggled
              because there&apos;s no import path for them yet.
            </p>
            <div className="max-h-128 overflow-y-auto rounded border border-border bg-surface-0">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-surface-2 text-left">
                  <tr>
                    <th className="w-8 px-2 py-1.5 font-medium" />
                    <th className="px-2 py-1.5 font-medium">Title</th>
                    <th className="px-2 py-1.5 font-medium">AGO type</th>
                    <th className="px-2 py-1.5 font-medium">Folder</th>
                    <th className="px-2 py-1.5 font-medium">Sharing</th>
                    <th className="px-2 py-1.5 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedItems.map((group) => {
                    const collapsed = collapsedGroups.has(group.type);
                    const totalInGroup = group.rows.length;
                    const isUnsupported = group.importableCount === 0;
                    return (
                      <Fragment key={group.type}>
                        <tr
                          className={`border-t border-border bg-surface-1 ${
                            isUnsupported ? 'text-muted' : 'text-ink-0'
                          }`}
                        >
                          <td
                            colSpan={6}
                            className="cursor-pointer px-2 py-1.5"
                            onClick={() => toggleGroup(group.type)}
                          >
                            <div className="flex items-center gap-2">
                              {collapsed ? (
                                <ChevronRight className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                              <span className="font-medium">{group.type}</span>
                              <span className="text-muted">
                                {isUnsupported
                                  ? `(${totalInGroup} - unsupported)`
                                  : `(${group.importableCount} of ${totalInGroup} importable)`}
                              </span>
                            </div>
                          </td>
                        </tr>
                        {!collapsed &&
                          group.rows.map((row) => {
                            const toggleable = isToggleable(row);
                            const included = willActuallyImport(row);
                            // Dim ANY row that isn't going to land
                            // in the portal: classifier-skipped
                            // rows are dimmed the same way an
                            // operator-excluded row is, so the
                            // eye can pick the actionable rows out.
                            const dim = !included;
                            return (
                              <tr
                                key={row.agoId}
                                className={`border-t border-border align-top ${
                                  dim ? 'opacity-50' : ''
                                }`}
                              >
                                <td className="px-2 py-1.5">
                                  <input
                                    type="checkbox"
                                    disabled={!toggleable}
                                    checked={included}
                                    onChange={() => toggleRow(row.agoId)}
                                    className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
                                    aria-label={
                                      toggleable
                                        ? `Include ${row.title} in import`
                                        : `${row.title} cannot be imported (unsupported type)`
                                    }
                                  />
                                </td>
                                <td className="px-2 py-1.5">{row.title}</td>
                                <td className="px-2 py-1.5 font-mono text-muted">
                                  {row.agoType}
                                </td>
                                <td className="px-2 py-1.5 text-muted">
                                  {row.folderTitle}
                                </td>
                                <td className="px-2 py-1.5 text-muted">
                                  {row.access ?? ''}
                                </td>
                                <td className="px-2 py-1.5">
                                  {toggleable ? (
                                    included ? (
                                      <span className="text-success">
                                        -&gt; {row.targetType}
                                      </span>
                                    ) : (
                                      <span className="text-muted">
                                        excluded
                                      </span>
                                    )
                                  ) : (
                                    <span className="text-muted">
                                      skip - {row.reason ?? 'no reason'}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {jobProgress && !importReport && (
        <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
          <h2 className="text-base font-semibold">
            {jobProgress.status === 'cancelled'
              ? 'Import cancelled'
              : jobProgress.status === 'failed'
              ? 'Import failed'
              : 'Import in progress'}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {jobProgress.status === 'queued'
              ? 'Waiting for the runner to pick up the job...'
              : jobProgress.currentItem
              ? `Next: ${jobProgress.currentItem}`
              : `Processed ${jobProgress.done} of ${jobProgress.total} item(s).`}
          </p>
          <div className="mt-3 h-2 w-full overflow-hidden rounded bg-surface-2">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${
                  jobProgress.total > 0
                    ? Math.round((jobProgress.done / jobProgress.total) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            {jobProgress.done} / {jobProgress.total} item(s)
          </p>
          {(jobProgress.status === 'queued' ||
            jobProgress.status === 'running') && (
            <button
              type="button"
              className="mt-3 rounded border border-border bg-surface-0 px-3 py-1 text-xs text-ink-1 hover:bg-surface-2"
              onClick={cancelImport}
            >
              Cancel import
            </button>
          )}
        </section>
      )}

      {importReport && (
        <section
          ref={importResultsRef}
          className="rounded-lg border-2 border-success bg-success/5 p-5 shadow-card"
        >
          <h2 className="flex items-center gap-2 text-base font-semibold text-success">
            <CheckCircle2 className="h-5 w-5" />
            Import complete
          </h2>
          <p className="mt-1 text-xs text-muted">
            Completed in {(importReport.durationMs / 1000).toFixed(1)} s.
            {importReport.folders.length > 0 ? (
              <>
                {' '}
                Created {importReport.folders.length} folder(s) mirroring the
                AGO layout.
              </>
            ) : null}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Counter label="Created" value={importReport.created} tone="ok" />
            <Counter
              label="Failed"
              value={importReport.failed}
              tone={importReport.failed > 0 ? 'error' : 'neutral'}
            />
            <Counter
              label="Skipped"
              value={importReport.skipped}
              tone="warn"
            />
          </div>
          <div className="mt-4 max-h-96 overflow-y-auto rounded border border-border bg-surface-0">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Title</th>
                  <th className="px-2 py-1.5 font-medium">AGO type</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Portal item</th>
                  <th className="px-2 py-1.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {importReport.results.map((row, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    <td className="px-2 py-1.5">{row.agoTitle}</td>
                    <td className="px-2 py-1.5 font-mono text-muted">
                      {row.agoType}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.status === 'created' && (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          created
                        </span>
                      )}
                      {row.status === 'failed' && (
                        <span className="text-danger">failed</span>
                      )}
                      {row.status === 'skipped' && (
                        <span className="text-warning">skipped</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-muted">
                      {row.portalItemId ? (
                        <a
                          className="hover:underline"
                          href={`/items/${row.portalItemId}`}
                        >
                          {row.portalItemId.slice(0, 8)}...
                        </a>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-muted">
                      {row.error ?? row.warnings.join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function PickConnectionPanel({
  conns,
  loadError,
  selectedId,
  onSelect,
  onSignIn,
  onCancelSignIn,
  busy,
}: {
  conns: AgoConnection[] | null;
  loadError: string | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  busy: 'auth' | 'preview' | 'run' | null;
}) {
  if (loadError) {
    return (
      <div className="rounded border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
        Failed to load AGO connections: {loadError}
      </div>
    );
  }
  if (conns === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading AGO connections...
      </p>
    );
  }
  if (conns.length === 0) {
    return (
      <>
        <h2 className="text-base font-semibold">No AGO connections yet</h2>
        <p className="mt-1 text-xs text-muted">
          Register at least one AGO portal before importing. One-time
          setup; afterwards sign-in is one click.
        </p>
        <Link
          href="/admin/migrations/from-ago/connections"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          <Plus className="h-4 w-4" />
          Add AGO connection
        </Link>
      </>
    );
  }
  return (
    <>
      <h2 className="text-base font-semibold">Sign in to ArcGIS Online</h2>
      <p className="mb-4 mt-1 text-xs text-muted">
        Pick which AGO portal to import from. The sign-in happens in
        a popup; the token never leaves this portal.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted">AGO connection</span>
        <select
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
        >
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.orgHost})
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!selectedId || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={onSignIn}
        >
          {busy === 'auth' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          {busy === 'auth' ? 'Waiting for sign-in...' : 'Sign in to ArcGIS Online'}
        </button>
        {busy === 'auth' && (
          <button
            type="button"
            onClick={onCancelSignIn}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-ink-0"
          >
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

function SignedInPanel({
  session,
  onSignOut,
  busy,
  onPreview,
  onRun,
  canRun,
}: {
  session: SessionState;
  onSignOut: () => void;
  busy: 'auth' | 'preview' | 'run' | null;
  onPreview: () => void;
  onRun: () => void;
  canRun: boolean;
}) {
  const minutesLeft = Math.max(
    0,
    Math.floor((session.expiresAtMs - Date.now()) / 60000),
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            Connected to {session.connectionDisplayName}
          </h2>
          <p className="mt-1 text-xs text-muted">
            token expires in ~{minutesLeft} min
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink-0"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          onClick={onPreview}
        >
          {busy === 'preview' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Preview what will be imported
        </button>
        <button
          type="button"
          disabled={!canRun || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={onRun}
        >
          {busy === 'run' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Run import
        </button>
      </div>
    </>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
}) {
  const toneClasses: Record<typeof tone, string> = {
    ok: 'border-success/30 bg-success/5 text-success',
    warn: 'border-warning/30 bg-warning/5 text-warning',
    error: 'border-danger/30 bg-danger/5 text-danger',
    neutral: 'border-border bg-surface-0 text-ink-0',
  };
  return (
    <div className={`rounded border px-3 py-2 ${toneClasses[tone]}`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}
