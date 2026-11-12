// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Most addresses a form may list in `notify.extraRecipients`. Each
 * one gets a copy of every submission, with text the form author and
 * the submitter wrote, from the install's own mail identity. Without
 * a limit any form author could use the portal to mail any number of
 * outside addresses.
 */
export const MAX_FORM_EXTRA_RECIPIENTS = 10;

/** Refuse a form save that lists more extra recipients than allowed. */
export function assertFormNotifyLimits(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const notify = (data as { notify?: unknown }).notify;
  if (!notify || typeof notify !== 'object') return;
  const extras = (notify as { extraRecipients?: unknown }).extraRecipients;
  if (Array.isArray(extras) && extras.length > MAX_FORM_EXTRA_RECIPIENTS) {
    throw new BadRequestException(
      `A form can send submission emails to at most ${MAX_FORM_EXTRA_RECIPIENTS} extra addresses.`,
    );
  }
}

/**
 * The extra recipients a submission is actually mailed to: valid
 * addresses, without duplicates, at most MAX_FORM_EXTRA_RECIPIENTS.
 * Applied again at send time for forms saved before the limit.
 */
export function formExtraRecipients(
  raw: unknown,
  isAddress: (a: string) => boolean,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const addr = e.trim();
    if (!isAddress(addr) || seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    out.push(addr);
    if (out.length >= MAX_FORM_EXTRA_RECIPIENTS) break;
  }
  return out;
}
