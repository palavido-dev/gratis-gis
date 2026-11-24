// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * "Save as" for a map (#797). Used from the map builder's toolbar and
 * from the map's item page. Both send POST /items/:id/copy and move to
 * the new map's builder.
 */
import { useEffect, useRef, useState } from 'react';
import { CopyPlus, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseApiError } from '@/lib/api-error';
import { useT } from '@/lib/i18n/locale-context';

/** Server limit on item titles (CopyItemDto). */
const TITLE_MAX = 200;

export function SaveMapCopyDialog({
  open,
  onOpenChange,
  sourceId,
  sourceTitle,
  hasMarkup,
  hasUnsavedChanges = false,
  getData,
  onBeforeNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  sourceTitle: string;
  /** Whether the map has any markup, so the checkbox is worth showing. */
  hasMarkup: boolean;
  hasUnsavedChanges?: boolean;
  /** The builder's live map state. Omitted, the server copies the map
   *  as it was last saved. */
  getData?: () => unknown;
  /** Runs right before the redirect, so the builder can stand down
   *  its unsaved-changes prompt for a navigation it asked for. */
  onBeforeNavigate?: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [includeMarkup, setIncludeMarkup] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A held Enter fires submit again before `saving` re-renders, which
  // would create two copies.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setTitle(t('mapSaveAs.defaultTitle', { title: sourceTitle }).slice(0, TITLE_MAX));
    setIncludeMarkup(true);
    setError(null);
  }, [open, sourceTitle, t]);

  async function submit() {
    const name = title.trim();
    if (!name || inFlight.current) return;
    inFlight.current = true;
    let leaving = false;
    setSaving(true);
    setError(null);
    try {
      const data = getData?.();
      const res = await fetch(`/api/portal/items/${sourceId}/copy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: name,
          includeMarkup: hasMarkup && includeMarkup,
          ...(data !== undefined ? { data } : {}),
        }),
      });
      if (!res.ok) {
        setError(await parseApiError(res, t('mapSaveAs.failed')));
        return;
      }
      const created = (await res.json()) as { id: string };
      onBeforeNavigate?.();
      leaving = true;
      window.location.assign(`/items/${created.id}?view=configure`);
    } finally {
      if (!leaving) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (saving ? undefined : onOpenChange(o))}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('mapSaveAs.title')}</DialogTitle>
            <DialogDescription>
              {hasUnsavedChanges
                ? t('mapSaveAs.descriptionUnsaved')
                : t('mapSaveAs.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-0">{t('mapSaveAs.nameLabel')}</span>
              <input
                autoFocus
                type="text"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0"
              />
            </label>
            {hasMarkup ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeMarkup}
                  onChange={(e) => setIncludeMarkup(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-ink-0">{t('mapSaveAs.includeMarkup')}</span>
                  <span className="block text-xs text-muted">
                    {t('mapSaveAs.includeMarkupHint')}
                  </span>
                </span>
              </label>
            ) : null}
            <p className="text-xs text-muted">{t('mapSaveAs.layersNote')}</p>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {t('mapSaveAs.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? t('mapSaveAs.saving') : t('mapSaveAs.submit')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The item page's way in: a button that opens the dialog. The page is
 * a server component, so the open state lives here.
 */
export function SaveMapCopyButton({
  sourceId,
  sourceTitle,
  hasMarkup,
}: {
  sourceId: string;
  sourceTitle: string;
  hasMarkup: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
      >
        <CopyPlus className="h-4 w-4" />
        {t('mapSaveAs.button')}
      </button>
      <SaveMapCopyDialog
        open={open}
        onOpenChange={setOpen}
        sourceId={sourceId}
        sourceTitle={sourceTitle}
        hasMarkup={hasMarkup}
      />
    </>
  );
}
