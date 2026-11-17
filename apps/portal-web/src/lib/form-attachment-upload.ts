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
import { PresignUploadError, presignUpload } from '@/lib/presign-upload';

/** The server's cap for a form attachment (FEATURE_ATTACHMENT_MAX_BYTES
 *  in portal-api storage.service.ts). It refuses to sign anything
 *  larger, so a larger file can never be uploaded, now or later. */
export const FORM_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Why a picked file cannot be attached, or null when it can. Checked
 * before uploading and before keeping a file offline: a file over the
 * cap used to be kept as an inline data URL (a 100 MB video becomes a
 * 133 MB string in memory) that the drain then retried for ever.
 */
export function attachmentSizeProblem(
  sizeBytes: number,
  questionMaxBytes?: number,
): string | null {
  const cap =
    typeof questionMaxBytes === 'number' && questionMaxBytes > 0
      ? Math.min(questionMaxBytes, FORM_ATTACHMENT_MAX_BYTES)
      : FORM_ATTACHMENT_MAX_BYTES;
  if (sizeBytes <= cap) return null;
  return `File is ${formatBytes(sizeBytes)}; the limit is ${formatBytes(cap)}.`;
}

/** The file itself was refused (too large for the signed upload). */
export class AttachmentRefusedError extends Error {}

/**
 * True when a failed upload may work later (no network, the server or
 * storage busy), so keeping the file for the queue drain makes sense.
 * False when the server refused the file itself; keeping it would only
 * fail again on every drain.
 */
export function isRetryableUploadError(err: unknown): boolean {
  if (err instanceof PresignUploadError) return err.retryable;
  if (err instanceof AttachmentRefusedError) return false;
  return true;
}

export interface UploadedAttachment {
  /** Original filename or a synthesized one for camera captures. */
  name: string;
  /** MIME type the bytes were uploaded with. */
  mimeType: string;
  /** Byte length of the file. */
  sizeBytes: number;
  /** The private attachment route for the key. It serves the object
   *  only once a submission has registered it, so the runtime previews
   *  a fresh upload from a local copy (form-local-previews.ts). */
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
    throw new AttachmentRefusedError(
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
        // Keep any extra fields the capture recorded (a clip's
        // durationSec, for one) and swap only the bytes for the
        // uploaded location. Replacing the whole entry dropped them.
        // eslint-disable-next-line no-await-in-loop
        const uploaded = await uploadPendingAttachment(item as PendingAttachment);
        const merged: Record<string, unknown> = { ...item, ...uploaded };
        delete merged.dataUrl;
        node[i] = merged;
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

/**
 * How long an upload made by an earlier drain attempt is reused
 * instead of uploaded again. The server's upload grant for a key, and
 * the age below which the orphan sweep leaves an unregistered object
 * alone, are both 48 hours; half that leaves room for a slow POST.
 * After it the kept bytes are uploaded again under a fresh key.
 */
export const QUEUED_UPLOAD_REUSE_MS = 24 * 60 * 60 * 1000;

/** Private bookkeeping on a stored queue entry; never sent. */
const UPLOADED_AT = 'uploadedAtMs';

type Entry = Record<string, unknown>;

function hasKeptBytes(item: unknown): item is Entry {
  return (
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as Entry).dataUrl === 'string'
  );
}

function reusable(item: Entry, now: number): boolean {
  const at = item[UPLOADED_AT];
  return (
    typeof item.url === 'string' &&
    typeof item.key === 'string' &&
    typeof at === 'number' &&
    now - at >= 0 &&
    now - at < QUEUED_UPLOAD_REUSE_MS
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function walkQueued(node: any, now: number, onUploaded: () => void): Promise<void> {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const item = node[i];
      if (hasKeptBytes(item)) {
        if (reusable(item, now)) continue;
        const capture: Entry = { ...item };
        delete capture.url;
        delete capture.key;
        delete capture[UPLOADED_AT];
        const uploaded = await uploadPendingAttachment(capture as unknown as PendingAttachment);
        node[i] = { ...capture, ...uploaded, dataUrl: item.dataUrl, [UPLOADED_AT]: now };
        onUploaded();
      } else {
        await walkQueued(item, now, onUploaded);
      }
    }
    return;
  }
  for (const key of Object.keys(node)) {
    await walkQueued(node[key], now, onUploaded);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripKept(node: any): any {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripKept);
  if (typeof node.dataUrl === 'string' && typeof node.url === 'string') {
    const sent: Entry = { ...(node as Entry) };
    delete sent.dataUrl;
    delete sent[UPLOADED_AT];
    return sent;
  }
  const out: Entry = {};
  for (const key of Object.keys(node)) out[key] = stripKept(node[key]);
  return out;
}

/**
 * The queued-submission version of uploadPendingAttachmentsInResponse,
 * for the form outbox drain.
 *
 * Each upload is recorded on the stored row (through `persist`) even
 * when a later upload or the POST fails, so the next drain attempt
 * reuses it instead of uploading the same bytes again under a new key.
 * The device's copy of the bytes (`dataUrl`) stays on the stored row
 * next to the uploaded location until the POST succeeds: the uploaded
 * object is not tied to a submission until then, and if it is lost or
 * its upload grant runs out the bytes can still be sent again.
 *
 * Returns the answers to POST: uploaded locations only, no bytes.
 */
export async function uploadQueuedAttachments(
  response: Record<string, unknown>,
  persist: (stored: Record<string, unknown>) => Promise<void>,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const stored = structuredClone(response);
  let changed = false;
  try {
    await walkQueued(stored, now, () => {
      changed = true;
    });
  } finally {
    if (changed) await persist(stored);
  }
  return stripKept(stored) as Record<string, unknown>;
}
