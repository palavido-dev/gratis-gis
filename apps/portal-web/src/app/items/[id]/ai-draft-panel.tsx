// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bot, Copy, Loader2 } from 'lucide-react';

interface DraftClause {
  field: string;
  op: string;
  value: string;
}

interface AiDraft {
  summary: string;
  mapFilter: {
    layerTitle: string;
    filter: { combinator: 'all' | 'any'; clauses: DraftClause[] };
  } | null;
  layerSummary: { title: string; bullets: string[] } | null;
  formFields: Array<{ name: string; label: string; type: string }>;
}

/**
 * Asks the configured provider for a draft about this item.
 * The server never writes the item; the panel only renders what
 * came back so the user can copy it.
 */
export function AiDraftPanel({
  itemId,
  isAdmin,
}: {
  itemId: string;
  isAdmin: boolean;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/portal/ai/status');
        if (!res.ok) {
          if (!cancelled) setConfigured(false);
          return;
        }
        const body = (await res.json()) as { configured?: boolean };
        if (!cancelled) {
          setConfigured(body.configured === true);
          setUnconfigured(body.configured !== true);
        }
      } catch {
        if (!cancelled) setConfigured(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    const text = instruction.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch('/api/portal/ai/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId, instruction: text }),
      });
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
        draft?: AiDraft;
      } | null;
      if (res.status === 409 || body?.code === 'ai_not_configured') {
        setConfigured(false);
        setUnconfigured(true);
        setDraft(null);
        return;
      }
      if (!res.ok || !body?.draft) {
        setError(
          typeof body?.message === 'string'
            ? body.message
            : 'Could not draft a suggestion.',
        );
        return;
      }
      setDraft(body.draft);
    } catch {
      setError('Could not draft a suggestion.');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
      setCopied(true);
    } catch {
      setCopied(false);
      setError('Could not copy the draft.');
    }
  }

  const showUnconfigured = configured === false || unconfigured;

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-medium text-ink-0">Ask about this item</h2>
      </div>
      {configured === null ? (
        <p className="text-xs text-muted">Checking whether AI is connected…</p>
      ) : showUnconfigured ? (
        <div className="text-sm text-ink-1">
          <p>
            AI is not configured. An organization admin needs to connect a
            provider before drafts are available.
          </p>
          {isAdmin ? (
            <Link
              href="/admin/ai"
              className="mt-2 inline-flex text-sm font-medium text-accent hover:underline"
            >
              Connect a provider
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            Ask for a map filter, a layer summary, or a form-field list.
            This is a draft you can copy. Nothing is saved to the item.
          </p>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Suggest a filter for open inspections, or draft fields for a tree survey…"
            className="w-full resize-y rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || instruction.trim().length === 0}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Draft
            </button>
          </div>
          {error ? (
            <p className="mt-2 text-xs text-danger">{error}</p>
          ) : null}
          {draft ? (
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Draft
                </p>
                <button
                  type="button"
                  onClick={() => void copyDraft()}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-ink-1 hover:bg-surface-2"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-sm leading-relaxed text-ink-0">{draft.summary}</p>
              {draft.mapFilter ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-ink-1">
                    Suggested filter · {draft.mapFilter.layerTitle}
                  </p>
                  <ul className="mt-1 space-y-1 text-xs text-ink-1">
                    {draft.mapFilter.filter.clauses.map((clause, index) => (
                      <li key={`${clause.field}-${index}`}>
                        {index > 0
                          ? `${draft.mapFilter?.filter.combinator === 'any' ? 'or' : 'and'} `
                          : ''}
                        <span className="font-mono">
                          {clause.field} {clause.op}
                          {clause.op === 'is-null' || clause.op === 'is-not-null'
                            ? ''
                            : ` ${clause.value}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {draft.layerSummary ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-ink-1">
                    {draft.layerSummary.title}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-ink-1">
                    {draft.layerSummary.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {draft.formFields.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs text-ink-1">
                  {draft.formFields.map((field) => (
                    <li key={field.name}>
                      {field.label}{' '}
                      <span className="font-mono text-muted">
                        {field.name} · {field.type}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
