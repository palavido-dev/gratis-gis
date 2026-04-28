'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Info } from 'lucide-react';

/**
 * In-app replacement for window.confirm / window.alert (#138).
 *
 * The native browser dialogs look like a 1995 system error in dark
 * mode and break our visual language; this provider mounts a single
 * styled modal at the root of the tree and exposes promise-returning
 * hooks (`useConfirm`, `useAlert`) so callers keep the same
 * "await -> proceed" shape they had with the native versions.
 *
 * - useConfirm({...})  -> Promise<boolean>
 *     Resolves true when the primary button is clicked, false on
 *     cancel / Escape / backdrop click.
 *
 * - useAlert({...})    -> Promise<void>
 *     Resolves when the user dismisses (OK / Escape / backdrop).
 *
 * Variants ("default" | "danger") only affect the primary button
 * tone -- the destructive red appears for delete confirmations.
 *
 * Why a Promise API: every existing window.confirm callsite already
 * branches on a sync boolean, so wrapping it in `await` is a one-line
 * edit. A render-prop component would force restructuring all of
 * them.
 *
 * Stacking: at most one dialog is shown at a time. Calling
 * confirm() while another dialog is open queues behind it; we
 * handle that by simply replacing the queued one (the second
 * caller's Promise resolves; the first remains unresolved). In
 * practice nothing in the app calls confirm() during another
 * confirm.
 */

interface ConfirmOptions {
  title?: string;
  message: string;
  /** Label on the primary action; defaults to "OK" / "Delete"
   *  depending on variant. */
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
}

interface AlertOptions {
  title?: string;
  message: string;
  /** Tone used to pick the icon + accent color. "warn" surfaces a
   *  yellow triangle; "info" the blue circle. */
  tone?: 'info' | 'warn';
  okLabel?: string;
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

interface PendingConfirm {
  kind: 'confirm';
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}
interface PendingAlert {
  kind: 'alert';
  opts: AlertOptions;
  resolve: () => void;
}
type Pending = PendingConfirm | PendingAlert;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Stash the most-recent pending in a ref so the close handlers
  // resolve the right promise even if `pending` has been swapped
  // mid-flight (defensive; not expected in normal use).
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ kind: 'confirm', opts, resolve });
      }),
    [],
  );
  const alertFn = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) => {
        setPending({ kind: 'alert', opts, resolve });
      }),
    [],
  );

  const closeConfirm = useCallback((value: boolean) => {
    const p = pendingRef.current;
    if (p && p.kind === 'confirm') {
      p.resolve(value);
    }
    setPending(null);
  }, []);
  const closeAlert = useCallback(() => {
    const p = pendingRef.current;
    if (p && p.kind === 'alert') {
      p.resolve();
    }
    setPending(null);
  }, []);

  // Esc / Enter shortcuts. Esc cancels (confirm: false; alert:
  // dismiss). Enter accepts confirm primary. We bind on document so
  // the modal doesn't have to be focused for the keyboard to work.
  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pendingRef.current?.kind === 'confirm') closeConfirm(false);
        else if (pendingRef.current?.kind === 'alert') closeAlert();
      } else if (e.key === 'Enter') {
        // Don't hijack Enter when the focus is in a textarea; in
        // text inputs Enter accepts so it's fine.
        const tag = (e.target as HTMLElement | null)?.tagName ?? '';
        if (tag === 'TEXTAREA') return;
        e.preventDefault();
        if (pendingRef.current?.kind === 'confirm') closeConfirm(true);
        else if (pendingRef.current?.kind === 'alert') closeAlert();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, closeConfirm, closeAlert]);

  const value = useMemo<DialogContextValue>(
    () => ({ confirm, alert: alertFn }),
    [confirm, alertFn],
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      {pending ? (
        pending.kind === 'confirm' ? (
          <ConfirmDialog opts={pending.opts} onClose={closeConfirm} />
        ) : (
          <AlertDialog opts={pending.opts} onClose={closeAlert} />
        )
      ) : null}
    </DialogContext.Provider>
  );
}

export function useConfirm(): DialogContextValue['confirm'] {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <DialogProvider>');
  }
  return ctx.confirm;
}

export function useAlert(): DialogContextValue['alert'] {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useAlert must be used inside <DialogProvider>');
  }
  return ctx.alert;
}

// ---- Internals ---------------------------------------------------

function ConfirmDialog({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose: (v: boolean) => void;
}) {
  const variant = opts.variant ?? 'default';
  const confirmLabel =
    opts.confirmLabel ?? (variant === 'danger' ? 'Delete' : 'OK');
  const cancelLabel = opts.cancelLabel ?? 'Cancel';
  const title = opts.title ?? (variant === 'danger' ? 'Confirm delete' : 'Confirm');
  return (
    <Backdrop onClose={() => onClose(false)}>
      <DialogShell>
        <DialogHeader>
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              variant === 'danger'
                ? 'bg-danger/10 text-danger'
                : 'bg-accent/10 text-accent'
            }`}
          >
            <AlertTriangle className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold tracking-tight text-ink-0">
            {title}
          </h2>
        </DialogHeader>
        <p className="px-5 pb-4 text-sm leading-relaxed text-ink-1">
          {opts.message}
        </p>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onClose(false)}
            className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onClose(true)}
            autoFocus
            className={`inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-accent-foreground hover:opacity-90 ${
              variant === 'danger' ? 'bg-danger' : 'bg-accent'
            }`}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogShell>
    </Backdrop>
  );
}

function AlertDialog({
  opts,
  onClose,
}: {
  opts: AlertOptions;
  onClose: () => void;
}) {
  const tone = opts.tone ?? 'info';
  const title = opts.title ?? (tone === 'warn' ? 'Heads up' : 'Notice');
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <Backdrop onClose={onClose}>
      <DialogShell>
        <DialogHeader>
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              tone === 'warn'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-accent/10 text-accent'
            }`}
          >
            <Icon className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold tracking-tight text-ink-0">
            {title}
          </h2>
        </DialogHeader>
        <p className="whitespace-pre-line px-5 pb-4 text-sm leading-relaxed text-ink-1">
          {opts.message}
        </p>
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            {opts.okLabel ?? 'OK'}
          </button>
        </DialogFooter>
      </DialogShell>
    </Backdrop>
  );
}

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="contents">
        {children}
      </div>
    </div>
  );
}

function DialogShell({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-border bg-surface-1 shadow-raised">
      {children}
    </div>
  );
}

function DialogHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-5 pb-3 pt-4">{children}</div>
  );
}

function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
      {children}
    </div>
  );
}
