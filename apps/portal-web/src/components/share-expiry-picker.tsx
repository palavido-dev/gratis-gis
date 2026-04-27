'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock, X } from 'lucide-react';

/**
 * Compact expiry picker for share rows (#84). Click the clock to
 * open a popover with chip presets (7 / 30 / 90 days), a "Custom
 * date" date input, and a "Never" option that clears.
 *
 * value: ISO date string when an expiry is set, null / undefined
 *        when the share never expires. The popover surfaces the
 *        current state in a "Expires Apr 30, 2026" subtitle so
 *        the user can tell at a glance.
 *
 * onChange: receives an ISO string (set), null (clear), or skips
 *           the call entirely if the user dismissed without
 *           choosing.
 */
export function ShareExpiryPicker({
  value,
  onChange,
  disabled,
  // Visual size: inline (icon only, for share rows in a panel)
  // vs full (icon + label, for the big bulk dialog).
  variant = 'inline',
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  variant?: 'inline' | 'full';
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Sync the date input draft with the current value when the
  // popover opens. Outside-click / Escape closes.
  useEffect(() => {
    if (!open) return;
    setDraft(value ? value.slice(0, 10) : '');
    function onDoc(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, value]);

  const expiresAt = value ? new Date(value) : null;
  const isExpired = expiresAt ? expiresAt.getTime() <= Date.now() : false;
  const subtitle = expiresAt
    ? `${isExpired ? 'Expired' : 'Expires'} ${formatShortDate(expiresAt)}`
    : 'Never expires';

  function pickPreset(days: number) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    onChange(d.toISOString());
    setOpen(false);
  }
  function commitCustom() {
    if (!draft) return;
    // Treat the date input as a local-time end-of-day so a
    // "April 30" pick lasts the full day in the user's timezone.
    const d = new Date(`${draft}T23:59:59`);
    if (Number.isNaN(d.getTime())) return;
    onChange(d.toISOString());
    setOpen(false);
  }
  function clear() {
    onChange(null);
    setOpen(false);
  }

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={subtitle}
        className={
          variant === 'full'
            ? `inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs disabled:opacity-50 ${
                value
                  ? isExpired
                    ? 'border-danger/40 bg-danger/5 text-danger'
                    : 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`
            : `inline-flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-50 ${
                value
                  ? isExpired
                    ? 'text-danger hover:bg-danger/5'
                    : 'text-amber-700 hover:bg-amber-50'
                  : 'text-muted hover:bg-surface-2 hover:text-ink-1'
              }`
        }
      >
        <Clock className="h-3.5 w-3.5" />
        {variant === 'full' ? (
          <span>{value ? subtitle : 'Set expiry'}</span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Share expiry"
          className="absolute right-0 top-9 z-30 w-64 rounded-md border border-border bg-surface-1 p-2 shadow-overlay"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
            <span>Expires</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="h-5 w-5 rounded text-muted hover:bg-surface-2"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="mb-2 text-xs text-ink-1">{subtitle}</p>
          <div className="mb-2 grid grid-cols-3 gap-1">
            {[
              { d: 7, label: '7 days' },
              { d: 30, label: '30 days' },
              { d: 90, label: '90 days' },
            ].map(({ d, label }) => (
              <button
                key={d}
                type="button"
                onClick={() => pickPreset(d)}
                className="h-7 rounded border border-border bg-surface-1 px-1 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mb-2 flex items-center gap-1">
            <input
              type="date"
              value={draft}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDraft(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-[11px]"
            />
            <button
              type="button"
              onClick={commitCustom}
              disabled={!draft}
              className="h-7 rounded border border-accent bg-accent px-2 text-[11px] font-medium text-white disabled:opacity-50"
            >
              Set
            </button>
          </div>
          <button
            type="button"
            onClick={clear}
            disabled={!value}
            className="w-full rounded border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
          >
            Never expires
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
