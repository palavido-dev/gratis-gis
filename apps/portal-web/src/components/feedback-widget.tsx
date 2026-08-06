// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  X,
} from 'lucide-react';

/**
 * In-portal feedback (#146).
 *
 * The form itself has existed at /feedback since the feature shipped,
 * but the only links to it were on two public marketing pages, one of
 * them behind an env flag. Someone using the demo had no way to report
 * anything without knowing to type the URL, which defeated the purpose:
 * the audience for this is exactly the people who will not open a
 * GitHub issue.
 *
 * So: a tab pinned to the edge of every page, plus an entry in the
 * help menu for people who look for support there instead. Both open
 * this same dialog.
 *
 * Context is captured automatically rather than asked for, because a
 * reporter should not have to know what a user agent is to file a
 * useful bug. Everything gathered is either already in the request
 * (browser) or trivially visible (page, version, window size).
 */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export function FeedbackWidget({
  enabled,
  appVersion,
  defaultName,
  defaultEmail,
}: {
  /**
   * From portal-info's `features.feedback`, resolved server-side.
   * Passed as a prop rather than fetched here because portal-info
   * through the BFF requires a session, and the visitors this
   * feature exists for do not have one.
   */
  enabled: boolean;
  /** Portal version, recorded with the report so a bug can be tied
   *  to the build the reporter was actually running. */
  appVersion?: string | null;
  /** Prefill for a signed-in reporter. They can still edit both. */
  defaultName?: string | null;
  defaultEmail?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? '';

  // The dialog is a portal-wide affordance, but a few surfaces are
  // deliberately the whole viewport (field runtime, app viewer,
  // print preview). AppShellChrome already renders those bare, and
  // this widget mounts inside the chrome, so they are covered. The
  // check here is for browser fullscreen, which can be entered on
  // any page and where a floating tab over the map is exactly the
  // thing the user was trying to get away from.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement !== null);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Never offer feedback on the standalone feedback page: the full
  // form is already there and a floating button opening a dialog over
  // it would be absurd.
  const onFeedbackPage = pathname === '/feedback';

  if (!enabled || isFullscreen || onFeedbackPage) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-surface-1 px-4 py-2.5 text-sm font-medium text-ink-1 shadow-lg transition hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent print:hidden"
        aria-haspopup="dialog"
      >
        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
        Feedback
      </button>
      {open ? (
        <FeedbackDialog
          onClose={() => setOpen(false)}
          appVersion={appVersion ?? ''}
          defaultName={defaultName ?? ''}
          defaultEmail={defaultEmail ?? ''}
        />
      ) : null}
    </>
  );
}

export function FeedbackDialog({
  onClose,
  appVersion = '',
  defaultName = '',
  defaultEmail = '',
}: {
  onClose: () => void;
  appVersion?: string;
  defaultName?: string;
  defaultEmail?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [message, setMessage] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function pickFile(f: File | null) {
    setError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_SCREENSHOT_BYTES) {
      setError('That image is larger than 4 MB. Try a smaller screenshot.');
      return;
    }
    setFile(f);
  }

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
      // Multipart unconditionally: one code path whether or not an
      // image is attached is easier to reason about than branching
      // on content type, and the BFF streams either shape.
      const form = new FormData();
      form.set('message', message.trim());
      if (name.trim()) form.set('name', name.trim());
      if (email.trim()) form.set('email', email.trim());
      if (company) form.set('company', company);
      // Captured, not asked for. window.location rather than
      // document.referrer because the dialog opens over the page
      // being reported on, so the current URL IS the context.
      form.set('pageUrl', window.location.href.slice(0, 2000));
      form.set('viewport', `${window.innerWidth}x${window.innerHeight}`);
      if (appVersion) form.set('appVersion', appVersion.slice(0, 64));
      if (file) form.set('screenshot', file);

      const res = await fetch('/api/portal/feedback', {
        method: 'POST',
        body: form,
      });
      if (res.status === 429) {
        setError(
          'That is a lot of feedback in a short time. Try again in a few minutes.',
        );
        return;
      }
      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { message?: string };
          if (body?.message) detail = ` ${body.message}`;
        } catch {
          // Non-JSON error body; the status alone will have to do.
        }
        setError(`Could not send your feedback.${detail}`);
        return;
      }
      setDone(true);
    } catch {
      setError(
        'Could not reach the portal. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-border bg-surface-0 p-5 shadow-xl sm:rounded-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink-0">Send feedback</h2>
            <p className="mt-0.5 text-sm text-muted">
              Found a problem, or something confusing? Tell us here. No account
              needed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:bg-surface-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-center">
            <CheckCircle2
              className="mx-auto h-8 w-8 text-accent"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-medium text-ink-0">Thank you.</p>
            <p className="mt-1 text-sm text-muted">
              Your feedback went straight to the people building this.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label
                htmlFor="fb-message"
                className="mb-1 block text-sm font-medium text-ink-1"
              >
                What happened?
              </label>
              <textarea
                id="fb-message"
                ref={messageRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                maxLength={10000}
                required
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                placeholder="The parcels layer does not draw when I zoom past the county line."
              />
              <p className="mt-1 text-right text-xs text-muted">
                {message.length} / 10,000
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="fb-name"
                  className="mb-1 block text-sm font-medium text-ink-1"
                >
                  Name <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  id="fb-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </div>
              <div>
                <label
                  htmlFor="fb-email"
                  className="mb-1 block text-sm font-medium text-ink-1"
                >
                  Email{' '}
                  <span className="font-normal text-muted">
                    (optional, to reply)
                  </span>
                </label>
                <input
                  id="fb-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-ink-1">
                Screenshot{' '}
                <span className="font-normal text-muted">(optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-ink-1 hover:bg-surface-2">
                  <ImagePlus className="h-4 w-4" aria-hidden="true" />
                  Choose image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="sr-only"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {file ? (
                  <span className="flex min-w-0 items-center gap-2 text-sm text-muted">
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      className="shrink-0 rounded p-0.5 hover:bg-surface-2"
                      aria-label="Remove image"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : null}
              </div>
            </div>

            {/* Honeypot. Off-screen and out of the tab order: a person
                never sees it, a form-filling bot fills everything. */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '-10000px',
                width: '1px',
                height: '1px',
                overflow: 'hidden',
              }}
            >
              <label htmlFor="fb-company">Company</label>
              <input
                id="fb-company"
                name="company"
                tabIndex={-1}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>

            {error ? (
              <p className="flex items-start gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-1">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{error}</span>
              </p>
            ) : null}

            <p className="text-xs text-muted">
              We also record the page you are on, your browser, and your window
              size, so we can reproduce the problem.
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
