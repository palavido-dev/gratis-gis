// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Sites the Embed widget may frame on custom app runtime pages
 * (review 28b-5). One origin per line; the API normalizes and checks
 * each entry, since every one ends up in a CSP header.
 */
export function EmbedOriginsForm({ initial }: { initial: string[] }) {
  const t = useT();
  const [text, setText] = useState(initial.join('\n'));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/portal/admin/security/embed-origins', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origins: text.split('\n').map((l) => l.trim()).filter(Boolean),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        origins?: string[];
      };
      if (!res.ok) {
        setNote(body.message || t('adminSecurity.embedErr'));
        return;
      }
      setText((body.origins ?? []).join('\n'));
      setNote(t('adminSecurity.embedSaved'));
    } catch {
      setNote(t('adminSecurity.embedErr'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-border bg-surface-1 p-4">
      <h2 className="text-sm font-semibold text-ink-0">
        {t('adminSecurity.embedTitle')}
      </h2>
      <p className="text-sm text-ink-1">{t('adminSecurity.embedIntro')}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder="https://dashboards.example.org"
        className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-sm text-ink-0"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground disabled:opacity-50"
        >
          {busy ? t('adminSecurity.embedSaving') : t('adminSecurity.embedSave')}
        </button>
        {note ? <span className="text-sm text-ink-1">{note}</span> : null}
      </div>
    </section>
  );
}
