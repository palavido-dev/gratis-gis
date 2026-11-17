// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers behind the signature pad (components/form-inputs/
 * signature-input.tsx), kept here so they run under jest's node
 * environment.
 *
 * A signature answer is an array with one attachment: the pending
 * shape `{ name, mimeType, sizeBytes, dataUrl }` while it waits to
 * upload, or `{ name, mimeType, sizeBytes, url, key }` after. Answers
 * saved before the pad wrote that shape are a bare PNG data URL.
 */

export interface SignatureAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl?: string;
  url?: string;
  key?: string;
}

export const SIGNATURE_FILE_NAME = 'signature.png';
export const SIGNATURE_MIME = 'image/png';

/** The image to show for an answer, or null when there is none. */
export function signatureSrc(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.startsWith('data:image/') ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as SignatureAttachment | null;
  if (!first || typeof first !== 'object') return null;
  if (typeof first.url === 'string') return first.url;
  if (typeof first.dataUrl === 'string') return first.dataUrl;
  return null;
}

/** Decoded size of a base64 data URL's payload, in bytes. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** The pending answer for a freshly drawn pad. */
export function pendingSignature(dataUrl: string): SignatureAttachment[] {
  return [
    {
      name: SIGNATURE_FILE_NAME,
      mimeType: SIGNATURE_MIME,
      sizeBytes: dataUrlBytes(dataUrl),
      dataUrl,
    },
  ];
}
