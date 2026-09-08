// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Direct-to-MinIO upload helper for form attachments (#280, #233).
 *
 * Form attachments (photo, audio, video, file, drawing question types)
 * used to be base64-inlined into the response JSON. That blew past
 * Nest/Express's default 100 KB JSON body limit on submission, so a
 * single phone photo would 413 the POST. The fix is to PUT the bytes
 * directly to MinIO and store only the URL in the response.
 *
 * Two-phase upload, mirroring the v3 feature-attachments pattern:
 *   1. POST /api/portal/storage/presign-upload to get a short-lived
 *      uploadUrl.
 *   2. PUT the file bytes directly to that URL.
 * The API never buffers the bytes, so submissions stay tiny no matter
 * how large the captured media is.
 *
 * The helper is online-only by design. Form runtime callers fall back
 * to an offline-pending shape (dataUrl, no url) when navigator.onLine
 * is false; the queue drain re-runs this helper to upload pending
 * attachments before posting the submission.
 */
import { formatBytes } from '@/lib/format-bytes';
import { presignUpload } from '@/lib/presign-upload';

export interface UploadedAttachment {
  /** Original filename or a synthesized one for camera captures. */
  name: string;
  /** MIME type the bytes were uploaded with. */
  mimeType: string;
  /** Byte length of the file. */
  sizeBytes: number;
  /** Stable public URL (anonymous-read MinIO bucket). */
  url: string;
  /** Object key inside the bucket; useful for delete-on-undo. */
  key: string;
}

/**
 * Pending-upload shape used when capture happens offline. The form
 * runtime stores this in the response while queued; the drain step
 * upgrades it to UploadedAttachment before submitting.
 */
export interface PendingAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Inlined bytes for offline persistence. Replaced with url on
   *  drain. */
  dataUrl: string;
}

export type Attachment = UploadedAttachment | PendingAttachment;

export function isUploaded(a: Attachment): a is UploadedAttachment {
  return typeof (a as UploadedAttachment).url === 'string';
}

export function isPending(a: Attachment): a is PendingAttachment {
  return typeof (a as PendingAttachment).dataUrl === 'string'
    && typeof (a as UploadedAttachment).url !== 'string';
}

/**
 * Presign + PUT a single file. Returns the persistent attachment shape
 * that gets stored in the form response. Throws on any network or
 * size-cap failure so the caller can fall back to the pending-attachment
 * path or surface an error to the user.
 */
export async function uploadFormAttachment(file: File): Promise<UploadedAttachment> {
  const contentType = file.type || 'application/octet-stream';
  // Re-using the feature-attachment kind on purpose: server-side it's
  // just a path prefix in MinIO and a max-bytes setting (25 MB), both
  // of which are right for form attachments too. Adding a separate
  // 'form-attachment' kind would just duplicate config without changing
  // behavior.
  const presign = await presignUpload({
    kind: 'feature-attachment',
    contentType,
    sizeBytes: file.size,
  });
  // The server already refused an over-cap size before signing; this
  // only guards against a signer that did not enforce it.
  if (file.size > presign.maxBytes) {
    throw new Error(
      `File is ${formatBytes(file.size)}; limit is ${formatBytes(presign.maxBytes)}.`,
    );
  }
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed: HTTP ${putRes.status}`);
  }
  return {
    name: file.name || 'capture',
    mimeType: contentType,
    sizeBytes: file.size,
    url: presign.publicUrl,
    key: presign.key,
  };
}

/**
 * Convert a pending (offline) attachment into an uploaded one by re-
 * reading the dataUrl as a Blob and PUTting it. Used by the queue drain
 * step so a submission captured offline lands in MinIO before the JSON
 * is POSTed. A failure throws and leaves the response unchanged so the
 * outer drain marks the row failed and re-tries later.
 */
export async function uploadPendingAttachment(
  pending: PendingAttachment,
): Promise<UploadedAttachment> {
  const blob = await fetch(pending.dataUrl).then((r) => r.blob());
  const file = new File([blob], pending.name, { type: pending.mimeType });
  return uploadFormAttachment(file);
}

/**
 * Walk a form response object and upload any pending attachments it
 * contains, replacing them in-place with their uploaded counterparts.
 * Returns the same response object reference so callers can pass it
 * straight into the submit POST.
 *
 * The walk is deep + structural: it descends into objects, arrays, and
 * repeating-group entries. It identifies pending attachments by the
 * isPending() type guard, which is duck-typed (has dataUrl, no url).
 *
 * Designed to be safe to re-run on a partially-uploaded response: an
 * already-uploaded attachment is a no-op.
 */
export async function uploadPendingAttachmentsInResponse(
  response: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await walkAndUpload(response);
  return response;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function walkAndUpload(node: any): Promise<void> {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const item = node[i];
      if (
        item &&
        typeof item === 'object' &&
        typeof item.dataUrl === 'string' &&
        typeof item.url !== 'string'
      ) {
        // eslint-disable-next-line no-await-in-loop
        node[i] = await uploadPendingAttachment(item as PendingAttachment);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await walkAndUpload(item);
      }
    }
    return;
  }
  for (const key of Object.keys(node)) {
    // eslint-disable-next-line no-await-in-loop
    await walkAndUpload(node[key]);
  }
}
