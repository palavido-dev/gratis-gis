// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import {
  Check,
  ClipboardList,
  Copy,
  Database,
  ExternalLink,
} from 'lucide-react';

interface Props {
  /** The form item id. Drives /forms/[id]/respond + /items/[id]/responses. */
  formId: string;
  /** When the form has a paired data_layer (#283 / #284), pass its
   *  item id so we can render a fourth pill linking into the layer's
   *  standard detail page. The Response Viewer is a different lens
   *  (form-shaped); the data_layer page is the raw schema / table
   *  view, useful for power-users. */
  linkedLayerId: string | null;
}

/**
 * Action row for a form's detail page (#328).
 *
 * Replaces the previous "Respondent link: /forms/.../respond" inline
 * URL with proper pill buttons so:
 *
 *   - Open form    -> primary button, opens the respondent runtime
 *                     in a new tab.
 *   - Responses    -> opens the implicit Response Viewer (#321).
 *   - Copy link    -> copies the absolute respondent URL to the
 *                     clipboard. Used when the form author wants to
 *                     share the link elsewhere (email, Slack, etc.).
 *                     Briefly flips to "Copied" + checkmark on success.
 *   - View submissions data layer -> only when the form has a paired
 *                     data_layer; deep-links to the layer's regular
 *                     detail page.
 *
 * Sits ABOVE the form designer so the affordances are reachable
 * without scrolling past the canvas, AND mirrors the page-header
 * Open / Responses buttons (#323) for users who land here scrolled
 * down -- redundancy is intentional given how often the canvas
 * pushes the header offscreen on tall designs.
 */
export function FormActionsRow({ formId, linkedLayerId }: Props) {
  const [copied, setCopied] = useState(false);
  // Resolve the absolute URL on the client. SSR can't know the
  // user's origin (proxy / public-share host might differ), so we
  // build the link lazily at click time. The relative href on the
  // <a> tags is what actually navigates; the absolute URL only
  // matters for the clipboard payload.
  function buildRespondentUrl(): string {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/forms/${formId}/respond`;
  }

  function onCopy() {
    const url = buildRespondentUrl();
    // Best-effort: the modern Clipboard API needs a secure context.
    // Fall back to a hidden textarea + execCommand for older browsers
    // / non-HTTPS dev. Either way, flash the Copied indicator for a
    // moment so the user gets feedback.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).catch(() => {
        /* ignore -- the textarea fallback below would re-try if we
           cared, but we keep this simple: a copy failure is rare and
           the URL is also visible on hover via the title attr. */
      });
    } else if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* swallow -- non-critical */
      }
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <a
        href={`/forms/${formId}/respond`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 text-xs font-medium text-white shadow-card hover:bg-accent/90"
        title="Open the form to submit a response"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open form
      </a>
      <a
        href={`/items/${formId}/responses`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
        title="Browse submitted responses on a map and through the form view"
      >
        <ClipboardList className="h-3.5 w-3.5" />
        Responses
      </a>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
        title="Copy the respondent URL"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-success" />
            Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" />
            Copy link
          </>
        )}
      </button>
      {linkedLayerId ? (
        <a
          href={`/items/${linkedLayerId}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
          title="Open the auto-created data layer where submissions land"
        >
          <Database className="h-3.5 w-3.5" />
          Submissions data layer
        </a>
      ) : null}
    </div>
  );
}
