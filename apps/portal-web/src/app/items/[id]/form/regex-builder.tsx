// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/locale-context';
import { Check, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

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
  'block w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

export function RegexQuestionFields({
  pattern,
  flags,
  message,
  canEdit,
  onChange,
}: Props) {
  const t = useT();
  const [builderOpen, setBuilderOpen] = useState(false);
  return (
    <>
      <div>
        <div className="mb-0.5 flex items-center justify-between">
          <p className="text-2xs uppercase tracking-wide text-muted">
            {t('formDesigner.regex.pattern')}
          </p>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setBuilderOpen(true)}
            className="inline-flex items-center gap-1 text-2xs text-accent hover:underline disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            {t('formDesigner.regex.patternBuilder')}
          </button>
        </div>
        <input
          type="text"
          value={pattern}
          disabled={!canEdit}
          onChange={(e) => onChange({ pattern: e.target.value })}
          className={`${inputCls} font-mono`}
        />
        <p className="mt-1 text-2xs text-muted">
          {t('formDesigner.regex.anchorsHint')}
        </p>
      </div>
      <div className="mt-3">
        <p className="mb-0.5 text-2xs uppercase tracking-wide text-muted">
          {t('formDesigner.regex.flags')}
        </p>
        <input
          type="text"
          value={flags ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ flags: e.target.value || undefined })}
          className={`${inputCls} font-mono`}
          maxLength={6}
        />
        <p className="mt-1 text-2xs text-muted">
          {t('formDesigner.regex.flagsHint')}
        </p>
      </div>
      <div className="mt-3">
        <p className="mb-0.5 text-2xs uppercase tracking-wide text-muted">
          {t('formDesigner.regex.errorMessage')}
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
type RegexPresetId =
  | 'email'
  | 'url'
  | 'usPhone'
  | 'e164Phone'
  | 'usZip'
  | 'caPostal'
  | 'ukPostcode'
  | 'isoDate'
  | 'time24h'
  | 'lettersOnly'
  | 'alphanumeric'
  | 'digitsOnly'
  | 'positiveInt'
  | 'decimal'
  | 'uuid'
  | 'hexColor';

interface RegexPreset {
  id: RegexPresetId;
  name: string;
  description: string;
  pattern: string;
  flags?: string;
  sample: string;
}

const REGEX_PRESET_DEFS: Array<
  Pick<RegexPreset, 'id' | 'pattern' | 'flags' | 'sample'> & { flags?: string }
> = [
  {
    id: 'email',
    pattern: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
    sample: 'me@example.com',
  },
  {
    id: 'url',
    pattern: 'https?://[^\\s/$.?#].[^\\s]*',
    sample: 'https://example.com/path?x=1',
  },
  {
    id: 'usPhone',
    pattern: '\\+?1?[\\s.-]?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}',
    sample: '(555) 867-5309',
  },
  {
    id: 'e164Phone',
    pattern: '\\+?\\d{7,15}',
    sample: '+14155552671',
  },
  {
    id: 'usZip',
    pattern: '\\d{5}(-\\d{4})?',
    sample: '94110-1234',
  },
  {
    id: 'caPostal',
    pattern: '[A-Za-z]\\d[A-Za-z][\\s-]?\\d[A-Za-z]\\d',
    flags: 'i',
    sample: 'K1A 0B1',
  },
  {
    id: 'ukPostcode',
    pattern: '[A-Za-z]{1,2}\\d[A-Za-z\\d]?\\s*\\d[A-Za-z]{2}',
    flags: 'i',
    sample: 'SW1A 1AA',
  },
  {
    id: 'isoDate',
    pattern: '\\d{4}-\\d{2}-\\d{2}',
    sample: '2026-04-28',
  },
  {
    id: 'time24h',
    pattern: '[01]\\d|2[0-3]:[0-5]\\d(:[0-5]\\d)?',
    sample: '14:30',
  },
  {
    id: 'lettersOnly',
    pattern: '[A-Za-z\\s]+',
    sample: 'Maria Sanchez',
  },
  {
    id: 'alphanumeric',
    pattern: '[A-Za-z0-9]+',
    sample: 'GIS2026Alpha',
  },
  {
    id: 'digitsOnly',
    pattern: '\\d+',
    sample: '40291',
  },
  {
    id: 'positiveInt',
    pattern: '[1-9]\\d*',
    sample: '12345',
  },
  {
    id: 'decimal',
    pattern: '-?\\d+(\\.\\d+)?',
    sample: '-3.14',
  },
  {
    id: 'uuid',
    pattern:
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    sample: '550e8400-e29b-41d4-a716-446655440000',
  },
  {
    id: 'hexColor',
    pattern: '#?([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})',
    sample: '#1a73e8',
  },
];

function regexPresetsFromT(
  t: (key: string) => string,
): RegexPreset[] {
  return REGEX_PRESET_DEFS.map((def) => ({
    ...def,
    name: t(`formDesigner.regex.presets.${def.id}.name`),
    description: t(`formDesigner.regex.presets.${def.id}.description`),
  }));
}

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
  const t = useT();
  const presets = useMemo(() => regexPresetsFromT(t), [t]);
  const [pattern, setPattern] = useState(initialPattern);
  const [flags, setFlags] = useState(initialFlags);
  const [sample, setSample] = useState('');
  const [pickedPreset, setPickedPreset] = useState<RegexPresetId | null>(null);

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
        error:
          e instanceof Error ? e.message : t('formDesigner.regex.invalidPatternShort'),
      };
    }
  }, [pattern, flags, sample]);

  function applyPreset(p: RegexPreset) {
    setPattern(p.pattern);
    setFlags(p.flags ?? '');
    setSample(p.sample);
    setPickedPreset(p.id);
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size="lg"
        className="grid !max-w-3xl grid-rows-[auto_1fr_auto] overflow-hidden bg-surface-0 p-0 shadow-xl"
        style={{ height: '80vh', maxHeight: 640 }}
      >
        <header className="border-b border-border bg-surface-1 px-4 py-2 pr-12">
          <p className="text-2xs uppercase tracking-wide text-muted">
            {t('formDesigner.regex.modalTitle')}
          </p>
          <DialogTitle className="text-sm font-medium text-ink-0">
            {t('formDesigner.regex.modalHeading')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('formDesigner.regex.modalDescriptionSr')}
          </DialogDescription>
        </header>
        <div className="grid grid-cols-1 divide-border overflow-y-auto md:grid-cols-[1fr_300px] md:divide-x md:overflow-hidden">
          {/* Left: preset list */}
          <div className="overflow-auto p-3">
            <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">
              {t('formDesigner.regex.commonPatterns')}
            </p>
            <ul className="space-y-1">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                      pickedPreset === p.id
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-surface-1 hover:bg-surface-2'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {pickedPreset === p.id ? (
                        <Check className="h-3 w-3 text-accent" />
                      ) : null}
                      <span className="font-medium text-ink-0">{p.name}</span>
                    </div>
                    <p className="mt-0.5 text-2xs text-muted">
                      {p.description}
                    </p>
                    <p className="mt-1 truncate font-mono text-2xs text-muted">
                      {p.pattern}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Right: pattern + preview */}
          <aside className="flex min-h-0 flex-col overflow-auto bg-surface-1 p-3 text-xs">
            <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted">
              {t('formDesigner.regex.pattern')}
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
            <p className="mt-2 mb-1 text-2xs font-medium uppercase tracking-wide text-muted">
              {t('formDesigner.regex.flags')}
            </p>
            <input
              type="text"
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
              maxLength={6}
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-2xs text-muted">
              {t('formDesigner.regex.flagsLegend')}
            </p>

            <p className="mt-4 mb-1 text-2xs font-medium uppercase tracking-wide text-muted">
              {t('formDesigner.regex.livePreview')}
            </p>
            <input
              type="text"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder={t('formDesigner.regex.samplePlaceholder')}
              className={inputCls}
            />
            <div className="mt-2 rounded-md border border-border bg-surface-0 px-2 py-1.5 text-2xs">
              {!previewResult.ok ? (
                <p className="text-danger">
                  {t('formDesigner.regex.invalidPattern', {
                    error: previewResult.error ?? '',
                  })}
                </p>
              ) : sample === '' ? (
                <p className="text-muted">
                  {t('formDesigner.regex.enterSample')}
                </p>
              ) : previewResult.match ? (
                <p className="text-success">
                  <Check className="mr-1 inline h-3 w-3" />
                  {t('formDesigner.regex.sampleMatches')}
                </p>
              ) : (
                <p className="text-warn">
                  {t('formDesigner.regex.sampleNoMatch')}
                </p>
              )}
            </div>
            <p className="mt-3 text-2xs text-muted">
              {t('formDesigner.regex.anchorNote')}
            </p>
          </aside>
        </div>
        <DialogFooter className="bg-surface-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-0 px-3 py-1 text-xs hover:bg-surface-2"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!previewResult.ok || !pattern}
            onClick={() => onApply(pattern, flags)}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('formDesigner.regex.applyPattern')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
