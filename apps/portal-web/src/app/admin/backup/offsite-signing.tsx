// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { BadgeCheck, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';
import { useFormat } from '@/lib/i18n/format';

/**
 * The signing key as GET /admin/backup/offsite returns it. Only the
 * verify key (public) and fingerprints; the signing key itself never
 * leaves the server.
 */
export interface OffsiteSigningInfo {
  verifyKey: string | null;
  fingerprint: string | null;
  changedAt: string | null;
  changedBy: string | null;
  previousFingerprints: string[];
  available: boolean;
  /** A signing key is stored but cannot be opened; the next upload replaces it. */
  unopenable?: boolean;
}

/** What the admin runs on their own computer; not translated. */
const KEY_PUBLIC = 'node offsite-key.mjs public my-portal.ggkey';

function trustCommand(verifyKey: string): string {
  return `node offsite-key.mjs trust my-portal.ggkey my-portal-new.ggkey ${verifyKey}`;
}

async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return typeof msg === 'string' && msg.trim() ? msg : null;
  } catch {
    return null;
  }
}

const inputClass =
  'w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none';

/**
 * Signing of off-site copies: the verify key to add to the key file,
 * "Check my verify key", and "Make a new signing key".
 */
export function OffsiteSigning({
  signing,
  onChanged,
}: {
  signing: OffsiteSigningInfo;
  onChanged: () => Promise<void> | void;
}) {
  const t = useT();
  const fmt = useFormat();
  const [checkValue, setCheckValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [renewResult, setRenewResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function check() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch('/api/portal/admin/backup/offsite/check-verify-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: checkValue }),
      });
      if (!res.ok) {
        setCheckResult({
          ok: false,
          text: (await serverMessage(res)) ?? t('adminBackup.offsite.checkVerifyFailed'),
        });
        return;
      }
      const body = (await res.json()) as {
        matches: boolean;
        previous: boolean;
        serverFingerprint: string | null;
        checkedFingerprint: string;
      };
      if (body.matches) {
        setCheckResult({
          ok: true,
          text: t('adminBackup.offsite.checkVerifyMatch', {
            fingerprint: body.serverFingerprint ?? '',
          }),
        });
      } else if (body.serverFingerprint === null) {
        setCheckResult({ ok: false, text: t('adminBackup.offsite.checkVerifyNoKey') });
      } else if (body.previous) {
        setCheckResult({
          ok: false,
          text: t('adminBackup.offsite.checkVerifyPrevious', { server: body.serverFingerprint }),
        });
      } else {
        setCheckResult({
          ok: false,
          text: t('adminBackup.offsite.checkVerifyMismatch', {
            server: body.serverFingerprint,
            checked: body.checkedFingerprint,
          }),
        });
      }
    } catch {
      setCheckResult({ ok: false, text: t('adminBackup.offsite.checkVerifyFailed') });
    } finally {
      setChecking(false);
    }
  }

  async function renew() {
    if (!window.confirm(t('adminBackup.offsite.newSigningKeyConfirm'))) return;
    setRenewing(true);
    setRenewResult(null);
    try {
      const res = await fetch('/api/portal/admin/backup/offsite/signing-key', { method: 'POST' });
      if (!res.ok) {
        setRenewResult({
          ok: false,
          text: (await serverMessage(res)) ?? t('adminBackup.offsite.newSigningKeyFailed'),
        });
        return;
      }
      setRenewResult({ ok: true, text: t('adminBackup.offsite.newSigningKeyDone') });
      setCheckResult(null);
      await onChanged();
    } catch {
      setRenewResult({ ok: false, text: t('adminBackup.offsite.newSigningKeyFailed') });
    } finally {
      setRenewing(false);
    }
  }

  return (
    <div className="rounded-md border border-border px-3 py-3">
      <p className="flex items-center gap-2 font-medium text-ink-0">
        <BadgeCheck className="h-4 w-4" aria-hidden />
        {t('adminBackup.offsite.signingTitle')}
      </p>
      <p className="mt-1 text-xs text-ink-1">{t('adminBackup.offsite.signingIntro')}</p>
      <p className="mt-1 text-xs text-ink-1">{t('adminBackup.offsite.signingLimit')}</p>

      {!signing.available ? (
        <p className="mt-2 text-xs font-medium text-danger">
          {t('adminBackup.offsite.verifyUnavailable')}
        </p>
      ) : signing.verifyKey && signing.fingerprint ? (
        <>
          {signing.unopenable ? (
            <p role="status" className="mt-2 text-xs font-medium text-danger">
              {t('adminBackup.offsite.signingUnopenable')}
            </p>
          ) : null}
          <label className="mt-3 block">
            <span className="text-xs font-medium text-ink-1">
              {t('adminBackup.offsite.verifyKey')}
            </span>
            <input
              className={`${inputClass} mt-1 font-mono`}
              value={signing.verifyKey}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
            />
          </label>
          <p className="mt-2 font-mono text-xs text-ink-0">
            {t('adminBackup.offsite.verifyFingerprint', { fingerprint: signing.fingerprint })}
          </p>
          <p className="mt-2 text-xs font-medium text-ink-0">
            {t('adminBackup.offsite.trustHowTo', { command: trustCommand(signing.verifyKey) })}
          </p>
          {signing.changedAt ? (
            <p className="mt-1 text-xs text-ink-1">
              {t('adminBackup.offsite.signingChanged', {
                when: fmt.dateTime(signing.changedAt),
                who: signing.changedBy ?? t('adminBackup.offsite.signingChangedServer'),
              })}
            </p>
          ) : null}
          {signing.previousFingerprints.length > 0 ? (
            <p className="mt-1 text-xs text-ink-1">
              {t('adminBackup.offsite.signingPrevious', {
                fingerprints: signing.previousFingerprints.join(', '),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-ink-1">{t('adminBackup.offsite.verifyNone')}</p>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs font-medium text-ink-0">
          {t('adminBackup.offsite.checkVerifyTitle')}
        </p>
        <p className="mt-1 text-xs text-ink-1">
          {t('adminBackup.offsite.checkVerifyHint', { command: KEY_PUBLIC })}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className={`${inputClass} flex-1 font-mono`}
            value={checkValue}
            onChange={(e) => setCheckValue(e.target.value)}
            placeholder={t('adminBackup.offsite.checkVerifyPlaceholder')}
            aria-label={t('adminBackup.offsite.checkVerifyTitle')}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={check}
            disabled={checking || checkValue.trim() === ''}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-ink-0 hover:bg-surface-2 disabled:opacity-60"
          >
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {checking ? t('adminBackup.offsite.checking') : t('adminBackup.offsite.checkKey')}
          </button>
        </div>
        {checkResult ? (
          <p
            role="status"
            className={
              checkResult.ok ? 'mt-2 text-xs text-emerald-700' : 'mt-2 text-xs text-danger'
            }
          >
            {checkResult.text}
          </p>
        ) : null}
      </div>

      {signing.available ? (
        <div className="mt-4 border-t border-border pt-3">
          <button
            type="button"
            onClick={renew}
            disabled={renewing}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-ink-0 hover:bg-surface-2 disabled:opacity-60"
          >
            {renewing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            {renewing
              ? t('adminBackup.offsite.newSigningKeyWorking')
              : t('adminBackup.offsite.newSigningKey')}
          </button>
          <p className="mt-1 text-2xs text-muted">{t('adminBackup.offsite.newSigningKeyHint')}</p>
          {renewResult ? (
            <p
              role="status"
              className={
                renewResult.ok ? 'mt-2 text-xs font-medium text-ink-0' : 'mt-2 text-xs text-danger'
              }
            >
              {renewResult.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
