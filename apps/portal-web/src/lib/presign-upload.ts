// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one client for `POST /api/portal/storage/presign-upload`.
 *
 * Three callers (feature attachments, form attachments, the file item
 * wizard) each hand-rolled the same request, and none of them sent the
 * file size. The server only signs Content-Length into the presigned
 * PUT when the client declares `sizeBytes`, so without it the per-kind
 * cap was advisory: the browser compared `file.size` against the
 * echoed `maxBytes`, and anything that skipped that check could PUT as
 * many bytes as it liked. Routing every presign through here makes the
 * size mandatory at the type level.
 *
 * `fetchImpl` exists for the offline queue drain, which replays through
 * its own fetch wrapper (retry classification, auth refresh) rather
 * than the bare global.
 */
import { parseApiError } from '@/lib/api-error';

/** Mirrors `PresignResult` in portal-api's storage.service.ts. */
export interface PresignResponse {
  /** URL the browser PUTs the bytes to. Short-lived. */
  uploadUrl: string;
  /** URL persisted on the owning entity after the upload completes. */
  publicUrl: string;
  /** Object key inside the bucket, without a leading slash. */
  key: string;
  /** The MIME type the PUT must match. */
  contentType: string;
  /** Per-kind cap the server enforced against `sizeBytes`. */
  maxBytes: number;
}

/** Kinds the browser may presign for; `map-icon` is server-side only. */
export type PresignKind =
  | 'item-thumb'
  | 'group-thumb'
  | 'user-avatar'
  | 'org-hero'
  | 'feature-attachment'
  | 'item-file'
  | 'item-tile-layer'
  | 'item-point-cloud';

export interface PresignUploadArgs {
  kind: PresignKind;
  contentType: string;
  /** Exact byte length of the blob about to be PUT. Signed into the URL. */
  sizeBytes: number;
  fetchImpl?: typeof fetch;
}

export const PRESIGN_UPLOAD_ENDPOINT = '/api/portal/storage/presign-upload';

/**
 * Request a presigned PUT. Throws an Error whose message is already the
 * sentence to show (an over-cap size comes back as the server's own
 * "File is too large ..." text), so callers do not need a second
 * client-side size check.
 */
export async function presignUpload({
  kind,
  contentType,
  sizeBytes,
  fetchImpl = fetch,
}: PresignUploadArgs): Promise<PresignResponse> {
  const res = await fetchImpl(PRESIGN_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, contentType, sizeBytes }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Could not start upload'));
  }
  return (await res.json()) as PresignResponse;
}
