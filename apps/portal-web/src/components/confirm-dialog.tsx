'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  description?: string;
  /**
   * If provided, the confirm button stays disabled until the user types this
   * exact string. Reserve for destructive actions on high-value data (e.g.
   * "Delete feature service: type the layer name to confirm").
   */
  requireTypedConfirmation?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' paints the confirm button red; 'primary' uses the accent color. */
  tone?: 'danger' | 'primary';
  /** Optional extra body content rendered between the description
   *  and the typed-confirmation/buttons row. Used by delete dialogs
   *  to show the dependents warning (#78). */
  children?: ReactNode;
}

/**
 * Minimal accessible confirm dialog built on the native <dialog> element.
 * - Focus-trapped by the browser when opened as a modal.
 * - Escape to cancel.
 * - For destructive ops, `requireTypedConfirmation` gates the confirm button
 *   until the user types the exact expected string. Forces deliberation.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  requireTypedConfirmation,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setSubmitting(false);
    }
  }, [open]);

  const gatedByTyping =
    !!requireTypedConfirmation && typed !== requireTypedConfirmation;

  async function handleConfirm() {
    if (gatedByTyping) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="rounded-lg border border-border bg-surface-1 p-0 text-ink-0 shadow-overlay backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="w-[28rem] max-w-[90vw] p-6">
        <div className="flex items-start gap-3">
          {tone === 'danger' ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
              <AlertTriangle className="h-4 w-4" />
            </div>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-0">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted">{description}</p>
            ) : null}
            {children}
          </div>
        </div>

        {requireTypedConfirmation ? (
          <div className="mt-4">
            <label className="mb-1 block text-xs text-muted">
              Type{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-ink-0">
                {requireTypedConfirmation}
              </code>{' '}
              to confirm:
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={gatedByTyping || submitting}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium shadow-card disabled:opacity-50 ${
              tone === 'danger'
                ? 'bg-danger text-white hover:opacity-90'
                : 'bg-accent text-accent-foreground hover:opacity-90'
            }`}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
