// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/locale-context';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  description?: string;
  /**
   * If provided, the confirm button stays disabled until the user types this
   * exact string. Reserve for destructive actions on high-value data (e.g.
   * "Delete data layer: type the layer name to confirm").
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
 * Shared confirm dialog, built on the ui/dialog primitive (#173).
 * Radix supplies focus trapping, escape-to-cancel, scroll lock, and
 * aria wiring; this component keeps the typed-confirmation gate for
 * destructive operations. The public props API is unchanged from the
 * previous native-<dialog> implementation.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  requireTypedConfirmation,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  children,
}: ConfirmDialogProps) {
  const t = useT();
  const resolvedConfirmLabel = confirmLabel ?? t('dialogs.confirm');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel();
      }}
    >
      <DialogContent hideCloseButton>
        <div className="flex items-start gap-3 px-5 pt-5">
          {tone === 'danger' ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
              <AlertTriangle className="h-4 w-4" />
            </div>
          ) : null}
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription className="mt-1">
                {description}
              </DialogDescription>
            ) : null}
            {children}
          </div>
        </div>

        {requireTypedConfirmation ? (
          <div className="px-5 pt-4">
            <label className="mb-1 block text-xs text-muted">
              {t('dialogs.typeToConfirmPrefix')}{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-2xs text-ink-0">
                {requireTypedConfirmation}
              </code>{' '}
              {t('dialogs.typeToConfirmSuffix')}
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

        <DialogFooter className="mt-5 border-t-0 bg-transparent pb-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {resolvedCancelLabel}
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
            {resolvedConfirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
