'use client';

import { useMemo, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';

/**
 * Regex pattern builder for the Pattern question type's `pattern`
 * field (#167). Survey123-inspired: a small set of preset patterns
 * the author can drop in with one click, plus a live preview that
 * tests sample input against the current pattern, plus the existing
 * raw-text input for power users.
 *
 * Used inside the Pattern question's Properties block. The builder
 * is a modal because some patterns are long and the Properties
 * column is narrow; a modal also gives us room for the live preview
 * and explanation copy.
 *
 * Wire format: stays a string + flags string -- same shape the
 * runtime's validateValue already consumes for regex questions, no
 * schema change.
 */

interface Props {
  pattern: string;
  flags?: string | undefined;
  message?: string | undefined;
  canEdit: boolean;
  onChange: (patch: {
    pattern?: string;
    flags?: string | undefined;
    message?: string | undefined;
  }) => void;
}

const inputCls =
  'block w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

export function RegexQuestionFields({
  pattern,
  flags,
  message,
  canEdit,
  onChange,
}: Props) {
  const [builderOpen, setBuilderOpen] = useState(false);
  return (
    <>
      <div>
        <div className="mb-0.5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted">
            Pattern
          </p>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setBuilderOpen(true)}
            className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            Pattern builder
          </button>
        </div>
        <input
          type="text"
          value={pattern}
          disabled={!canEdit}
          onChange={(e) => onChange({ pattern: e.target.value })}
          className={`${inputCls} font-mono`}
        />
        <p className="mt-1 text-[11px] text-muted">
          Regex applied with implicit ^...$ anchors.
        </p>
      </div>
      <div className="mt-3">
        <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">
          Flags
        </p>
        <input
          type="text"
          value={flags ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ flags: e.target.value || undefined })}
          className={`${inputCls} font-mono`}
          maxLength={6}
        />
        <p className="mt-1 text-[11px] text-muted">
          e.g. "i" for case-insensitive.
        </p>
      </div>
      <div className="mt-3">
        <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">
          Error message
        </p>
        <input
          type="text"
          value={message ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ message: e.target.value || undefined })}
          className={inputCls}
        />
      </div>
      {builderOpen ? (
        <RegexBuilderModal
          initialPattern={pattern}
          initialFlags={flags ?? ''}
          onClose={() => setBuilderOpen(false)}
          onApply={(p, f) => {
            onChange({ pattern: p, flags: f || undefined });
            setBuilderOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Common patterns the author can drop in with one click. Kept
 * deliberately simple -- each pattern is what the runtime will
 * actually anchor with ^...$, not a "fragment" we'd splice. Authors
 * who need something more complex paste their own pattern in the
 * raw textbox.
 *
 * Each preset has a name, a short description, the pattern itself,
 * and an example value the live-preview seeds with so the author
 * can see immediately whether the pattern matches what they expect.
 */
interface RegexPreset {
  name: string;
  description: string;
  pattern: string;
  flags?: string;
  sample: string;
}

const REGEX_PRESETS: RegexPreset[] = [
  {
    name: 'Email address',
    description: 'Pragmatic email check (matches what most validators accept).',
    pattern: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
    sample: 'me@example.com',
  },
  {
    name: 'URL (http / https)',
    description: 'Full URL with optional path.',
    pattern: 'https?://[^\\s/$.?#].[^\\s]*',
    sample: 'https://example.com/path?x=1',
  },
  {
    name: 'US phone number',
    description: 'Any common US format: 555-1234, (555) 555-1234, +1 555 555 1234.',
    pattern: '\\+?1?[\\s.-]?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}',
    sample: '(555) 867-5309',
  },
  {
    name: 'International phone (E.164)',
    description: 'Plus sign optional, 7-15 digits.',
    pattern: '\\+?\\d{7,15}',
    sample: '+14155552671',
  },
  {
    name: 'US ZIP code',
    description: '5 digits, optional 4-digit extension.',
    pattern: '\\d{5}(-\\d{4})?',
    sample: '94110-1234',
  },
  {
    name: 'Canadian postal code',
    description: 'A1A 1A1 (space optional, case-insensitive).',
    pattern: '[A-Za-z]\\d[A-Za-z][\\s-]?\\d[A-Za-z]\\d',
    flags: 'i',
    sample: 'K1A 0B1',
  },
  {
    name: 'UK postcode',
    description: 'Most common UK postcode formats.',
    pattern:
      '[A-Za-z]{1,2}\\d[A-Za-z\\d]?\\s*\\d[A-Za-z]{2}',
    flags: 'i',
    sample: 'SW1A 1AA',
  },
  {
    name: 'Date (YYYY-MM-DD)',
    description: 'ISO 8601 date.',
    pattern: '\\d{4}-\\d{2}-\\d{2}',
    sample: '2026-04-28',
  },
  {
    name: 'Time (HH:MM, 24h)',
    description: '24-hour time, optional seconds.',
    pattern: '[01]\\d|2[0-3]:[0-5]\\d(:[0-5]\\d)?',
    sample: '14:30',
  },
  {
    name: 'Letters only',
    description: 'Any alphabetic characters, with spaces.',
    pattern: '[A-Za-z\\s]+',
    sample: 'Maria Sanchez',
  },
  {
    name: 'Letters + numbers',
    description: 'Alphanumeric, no special characters.',
    pattern: '[A-Za-z0-9]+',
    sample: 'GIS2026Alpha',
  },
  {
    name: 'Digits only',
    description: 'Any number of digits.',
    pattern: '\\d+',
    sample: '40291',
  },
  {
    name: 'Whole number (positive)',
    description: 'Positive integer, no leading zero.',
    pattern: '[1-9]\\d*',
    sample: '12345',
  },
  {
    name: 'Decimal number',
    description: 'Optional sign + integer + optional fractional part.',
    pattern: '-?\\d+(\\.\\d+)?',
    sample: '-3.14',
  },
  {
    name: 'UUID',
    description: 'Standard 8-4-4-4-12 hex.',
    pattern:
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    sample: '550e8400-e29b-41d4-a716-446655440000',
  },
  {
    name: 'Hex color',
    description: '3- or 6-digit hex with optional leading #.',
    pattern: '#?([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})',
    sample: '#1a73e8',
  },
];

function RegexBuilderModal({
  initialPattern,
  initialFlags,
  onClose,
  onApply,
}: {
  initialPattern: string;
  initialFlags: string;
  onClose: () => void;
  onApply: (pattern: string, flags: string) => void;
}) {
  const [pattern, setPattern] = useState(initialPattern);
  const [flags, setFlags] = useState(initialFlags);
  const [sample, setSample] = useState('');
  const [pickedPreset, setPickedPreset] = useState<string | null>(null);

  // Compile + test live as the author types. Bad patterns produce
  // an error string instead of throwing; the runtime makes the same
  // tradeoff (a bad pattern means "no match", not "blocked").
  const previewResult = useMemo(() => {
    if (!pattern) return { ok: true, match: false, error: null as string | null };
    try {
      const re = new RegExp(`^(?:${pattern})$`, flags);
      return {
        ok: true,
        match: re.test(sample),
        error: null as string | null,
      };
    } catch (e) {
      return {
        ok: false,
        match: false,
        error: e instanceof Error ? e.message : 'Invalid pattern',
      };
    }
  }, [pattern, flags, sample]);

  function applyPreset(p: RegexPreset) {
    setPattern(p.pattern);
    setFlags(p.flags ?? '');
    setSample(p.sample);
    setPickedPreset(p.name);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="grid h-[80vh] max-h-[640px] w-full max-w-3xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border border-border bg-surface-0 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border bg-surface-1 px-4 py-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">
              Pattern builder
            </p>
            <h2 className="text-sm font-medium text-ink-0">
              Build a regex pattern
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="grid grid-cols-[1fr_300px] divide-x divide-border overflow-hidden">
          {/* Left: preset list */}
          <div className="overflow-auto p-3">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
              Common patterns
            </p>
            <ul className="space-y-1">
              {REGEX_PRESETS.map((p) => (
                <li key={p.name}>
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                      pickedPreset === p.name
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-surface-1 hover:bg-surface-2'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {pickedPreset === p.name ? (
                        <Check className="h-3 w-3 text-accent" />
                      ) : null}
                      <span className="font-medium text-ink-0">{p.name}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {p.description}
                    </p>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted">
                      {p.pattern}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Right: pattern + preview */}
          <aside className="flex min-h-0 flex-col overflow-auto bg-surface-1 p-3 text-xs">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              Pattern
            </p>
            <textarea
              rows={3}
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setPickedPreset(null);
              }}
              className={`${inputCls} font-mono`}
            />
            <p className="mt-2 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              Flags
            </p>
            <input
              type="text"
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
              maxLength={6}
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-[11px] text-muted">
              i = case-insensitive, m = multi-line, s = . matches newline.
            </p>

            <p className="mt-4 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              Live preview
            </p>
            <input
              type="text"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder="Type a sample value..."
              className={inputCls}
            />
            <div className="mt-2 rounded-md border border-border bg-surface-0 px-2 py-1.5 text-[11px]">
              {!previewResult.ok ? (
                <p className="text-danger">
                  Invalid pattern: {previewResult.error}
                </p>
              ) : sample === '' ? (
                <p className="text-muted">
                  Enter a sample to test the pattern.
                </p>
              ) : previewResult.match ? (
                <p className="text-emerald-700">
                  <Check className="mr-1 inline h-3 w-3" />
                  Sample matches the pattern.
                </p>
              ) : (
                <p className="text-amber-700">
                  Sample does not match. Adjust pattern or sample.
                </p>
              )}
            </div>
            <p className="mt-3 text-[10px] text-muted">
              The runtime anchors with implicit ^...$, so the pattern
              has to match the whole value -- not just any substring.
            </p>
          </aside>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-1 px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-0 px-3 py-1 text-xs hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!previewResult.ok || !pattern}
            onClick={() => onApply(pattern, flags)}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Apply pattern
          </button>
        </footer>
      </div>
    </div>
  );
}
