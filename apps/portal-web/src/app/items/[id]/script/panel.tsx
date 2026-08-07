// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Save,
  XCircle,
} from 'lucide-react';
import {
  SCRIPT_DEFAULT_TIMEOUT_SECONDS,
  SCRIPT_MAX_TIMEOUT_SECONDS,
  type ScriptData,
  type ScriptRunDetail,
  type ScriptRunSummary,
} from '@gratis-gis/shared-types';

/**
 * `script` item detail (#221).
 *
 * A plain textarea, not a code editor. Authoring is expected to happen
 * in the author's own editor, and shipping a syntax-highlighted
 * in-browser IDE would be a large dependency in service of the least
 * valuable third of what the hosted products bundle. This surface
 * exists to paste, save, run, and read what happened.
 */
const POLL_MS = 2000;
const LIVE_STATES = new Set(['queued', 'running', 'cancel_requested']);

export function ScriptPanel({
  itemId,
  initial,
  canEdit,
}: {
  itemId: string;
  initial: ScriptData;
  canEdit: boolean;
}) {
  const [source, setSource] = useState(initial.source ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [timeout, setTimeoutSeconds] = useState(
    initial.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS,
  );
  const [savedSource, setSavedSource] = useState(initial.source ?? '');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScriptRunSummary[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScriptRunDetail | null>(null);

  const dirty = source !== savedSource;
  const live = runs.some((r) => LIVE_STATES.has(r.state));

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/scripts/${itemId}/runs?limit=20`);
      if (!res.ok) return;
      setRuns((await res.json()) as ScriptRunSummary[]);
    } catch {
      // A failed poll is not worth a visible error; the next tick
      // usually succeeds and the run keeps going regardless.
    }
  }, [itemId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Poll only while something is actually in flight. A finished list
  // is static, and hammering the API for a page someone left open on
  // a second monitor is rude.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      void loadRuns();
      if (openRun) void loadDetail(openRun);
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, openRun, loadRuns]);

  async function loadDetail(runId: string) {
    try {
      const res = await fetch(`/api/portal/scripts/runs/${runId}`);
      if (!res.ok) return;
      setDetail((await res.json()) as ScriptRunDetail);
    } catch {
      // Same: transient.
    }
  }

  async function toggleRun(runId: string) {
    if (openRun === runId) {
      setOpenRun(null);
      setDetail(null);
      return;
    }
    setOpenRun(runId);
    setDetail(null);
    await loadDetail(runId);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: ScriptData = {
        version: 1,
        source,
        timeoutSeconds: timeout,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedSource(source);
    } catch {
      setError('Could not save the script.');
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    setStarting(true);
    setError(null);
    try {
      // Save first when there are unsaved edits. The run executes a
      // snapshot taken at enqueue, so running with a dirty editor
      // would run the PREVIOUS code while showing the new code, which
      // is the most confusing thing this page could do.
      if (dirty) await save();
      const res = await fetch(`/api/portal/scripts/${itemId}/run`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(body.message ?? 'Could not start the run.');
        return;
      }
      await loadRuns();
    } catch {
      setError('Could not reach the portal.');
    } finally {
      setStarting(false);
    }
  }

  async function cancel(runId: string) {
    try {
      await fetch(`/api/portal/scripts/runs/${runId}/cancel`, {
        method: 'POST',
      });
      await loadRuns();
    } catch {
      setError('Could not cancel that run.');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface-1">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-0">Python</h2>
            <p className="mt-0.5 text-xs text-muted">
              Runs on the server with your own permissions. The same file
              runs unchanged on your machine.
            </p>
          </div>
          {canEdit ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {dirty ? 'Save' : 'Saved'}
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={starting || live || source.trim().length === 0}
                title={
                  live
                    ? 'A run is already in progress'
                    : source.trim().length === 0
                      ? 'Add some code first'
                      : 'Run this script now'
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {starting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Run now
              </button>
            </div>
          ) : null}
        </header>

        <div className="p-4">
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            readOnly={!canEdit}
            spellCheck={false}
            rows={18}
            className="w-full rounded-md border border-border bg-surface-0 p-3 font-mono text-xs leading-relaxed text-ink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder={PLACEHOLDER}
          />

          {canEdit ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
              <div>
                <label
                  htmlFor="script-timeout"
                  className="mb-1 block text-xs font-medium text-ink-1"
                >
                  Time limit (seconds)
                </label>
                <input
                  id="script-timeout"
                  type="number"
                  min={1}
                  max={SCRIPT_MAX_TIMEOUT_SECONDS}
                  value={timeout}
                  onChange={(e) =>
                    setTimeoutSeconds(Number(e.target.value) || 1)
                  }
                  className="w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0"
                />
              </div>
              <div>
                <label
                  htmlFor="script-notes"
                  className="mb-1 block text-xs font-medium text-ink-1"
                >
                  What does this touch?{' '}
                  <span className="font-normal text-muted">
                    (for whoever presses Run next)
                  </span>
                </label>
                <input
                  id="script-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0"
                  placeholder="Replaces every feature in the Parcels layer from the county REST endpoint."
                />
              </div>
            </div>
          ) : notes ? (
            <p className="mt-3 text-xs text-muted">{notes}</p>
          ) : null}

          {error ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface-1">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-0">Runs</h2>
        </header>
        {runs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No runs yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.id}>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => void toggleRun(r.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {openRun === r.id ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                    )}
                    <RunState state={r.state} />
                    <span className="truncate text-xs text-muted">
                      {new Date(r.createdAt).toLocaleString()}
                      {r.trigger === 'schedule' ? ' (scheduled)' : ''}
                      {r.finishedAt && r.startedAt
                        ? ` · ${(
                            (new Date(r.finishedAt).getTime() -
                              new Date(r.startedAt).getTime()) /
                            1000
                          ).toFixed(1)}s`
                        : ''}
                    </span>
                  </button>
                  {canEdit && LIVE_STATES.has(r.state) ? (
                    <button
                      type="button"
                      onClick={() => void cancel(r.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ink-1 hover:bg-surface-2"
                    >
                      <Ban className="h-3 w-3" />
                      Cancel
                    </button>
                  ) : null}
                </div>
                {openRun === r.id ? (
                  <div className="border-t border-border bg-surface-0 px-4 py-3">
                    {r.error ? (
                      <p className="mb-2 text-xs text-danger">{r.error}</p>
                    ) : null}
                    {detail === null ? (
                      <p className="text-xs text-muted">Loading…</p>
                    ) : (
                      <>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-1 p-3 font-mono text-2xs leading-relaxed text-ink-1">
                          {detail.log && detail.log.length > 0
                            ? detail.log
                            : LIVE_STATES.has(r.state)
                              ? 'Waiting for output…'
                              : 'This run produced no output.'}
                        </pre>
                        {detail.sourceSnapshot &&
                        detail.sourceSnapshot !== source ? (
                          <p className="mt-2 text-2xs text-muted">
                            The script has been edited since this run. The
                            code above ran against the earlier version.
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunState({ state }: { state: string }) {
  const map: Record<string, { icon: React.ReactNode; label: string }> = {
    queued: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />,
      label: 'Queued',
    },
    running: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />,
      label: 'Running',
    },
    cancel_requested: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-warn" />,
      label: 'Cancelling',
    },
    done: {
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
      label: 'Succeeded',
    },
    failed: {
      icon: <XCircle className="h-3.5 w-3.5 text-danger" />,
      label: 'Failed',
    },
    cancelled: {
      icon: <Ban className="h-3.5 w-3.5 text-muted" />,
      label: 'Cancelled',
    },
  };
  const s = map[state] ?? {
    icon: <span className="h-3.5 w-3.5" />,
    label: state,
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-1">
      {s.icon}
      {s.label}
    </span>
  );
}

const PLACEHOLDER = `from gratisgis import GratisGIS

# The portal URL and an API key for this run are already in the
# environment, so from_env() is all you need on the server. The same
# call works on your machine once you export the two variables.
gg = GratisGIS.from_env()

layer = gg.find_items(type="data_layer", query="parcels")[0]
count = sum(1 for _ in gg.iter_features(layer["id"], "parcels"))
print(f"{layer['title']}: {count} features")
`;
