// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageSquarePlus,
} from 'lucide-react';

/**
 * Anonymous feedback form (#146). POSTs to /api/portal/feedback,
 * which the BFF forwards to portal-api's @Public() endpoint. The
 * UI:
 *
 *   - Name + email are optional; message is required.
 *   - A honeypot input named `company` is hidden via CSS + tab-
 *     order tricks. Bots scraping every input fill it; humans
 *     don't see it. The server silently 200s honeypot hits so
 *     bots don't learn we caught them.
 *   - Submit triggers an inline busy state, then either a success
 *     panel (replacing the form) or an inline error (form stays
 *     populated so the user can retry without retyping).
 *   - The page URL the user came from is captured so the
 *     maintainer can ask "what were you doing when this
 *     happened?" without playing 20 questions. Set on mount via
 *     document.referrer; gracefully empty when the user landed
 *     here directly.
 */
export function FeedbackForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [pageUrl, setPageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // The page the user came from. document.referrer is empty when
    // the user opened /feedback directly in a fresh tab; not a
    // problem, just less context for the maintainer.
    if (typeof document !== 'undefined') {
      setPageUrl(document.referrer || '');
    }
    // Focus the message field on mount so a user landing here can
    // start typing immediately. Name + email are optional so
    // skipping past them is the default flow.
    if (messageRef.current) {
      messageRef.current.focus();
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (message.trim().length < 2) {
      setError('Please enter a message.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Trim everything so a tab-key user who put an accidental
          // trailing space doesn't blow validation.
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          message: message.trim(),
          ...(pageUrl ? { pageUrl } : {}),
          // Honeypot. Real users leave this empty; bots fill it.
          // We always send it (even when empty) so the server
          // sees a uniform shape and doesn't infer based on
          // missing fields.
          company,
        }),
      });
      if (res.status === 429) {
        setError(
          'Too many submissions from your network. Try again in a few minutes.',
        );
        return;
      }
      if (!res.ok) {
        setError(
          `Could not send (HTTP ${res.status}). Try again, or use the GitHub link below.`,
        );
        return;
      }
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not send. Try again, or use the GitHub link below.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="mt-8 flex items-start gap-3 rounded-md border border-success/40 bg-success/5 p-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <div>
          <p className="font-medium text-ink-0">Thanks. It&rsquo;s landed.</p>
          <p className="mt-1 text-sm text-muted">
            The maintainer will read every message personally. If
            you included an email and want a reply, expect it within
            a few days. No follow-up needed on your side.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-medium text-ink-1">
            Name <span className="font-normal text-muted">(optional)</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoComplete="name"
            className="mt-1 h-9 w-full rounded border border-border bg-surface-1 px-2.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            placeholder="e.g. Sam Adams"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-ink-1">
            Email <span className="font-normal text-muted">(optional)</span>
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            autoComplete="email"
            className="mt-1 h-9 w-full rounded border border-border bg-surface-1 px-2.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            placeholder="you@example.com"
          />
        </label>
      </div>

      <label className="block">
        <span className="block text-xs font-medium text-ink-1">
          Message <span className="text-danger">*</span>
        </span>
        <textarea
          ref={messageRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={10000}
          rows={8}
          required
          className="mt-1 w-full rounded border border-border bg-surface-1 px-2.5 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          placeholder="What worked, what didn't, what surprised you. Specific repros land better than general impressions."
        />
        <span className="mt-1 block text-2xs text-muted">
          {message.length.toLocaleString()} / 10,000 characters
        </span>
      </label>

      {/* Honeypot. Absolutely-positioned off-screen + tab-key
          skipped + aria-hidden so screen readers and keyboard
          users never reach it. Bots that scrape every <input>
          and fill them all will set this to non-empty; the
          server silently 200s those without sending the email. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
        }}
      >
        <label>
          Company (leave blank)
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting || message.trim().length < 2}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MessageSquarePlus className="h-4 w-4" />
          )}
          {submitting ? 'Sending...' : 'Send feedback'}
        </button>
        <span className="text-2xs text-muted">
          Goes straight to the maintainer&rsquo;s inbox.
        </span>
      </div>
    </form>
  );
}
