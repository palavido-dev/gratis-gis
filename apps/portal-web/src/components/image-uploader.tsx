'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { EntityBadge, type BadgeRounded, type BadgeSize } from '@gratis-gis/ui';

export type AssetKind =
  | 'item-thumb'
  | 'group-thumb'
  | 'user-avatar'
  | 'org-hero';

interface Props {
  /** What kind of asset this uploader produces; shapes the storage path. */
  kind: AssetKind;
  /** Current image URL (persisted on the entity) or null for "no custom image". */
  value: string | null;
  /** Fires with the new URL after a successful upload, or null when cleared. */
  onChange: (next: string | null) => void;
  /** Used for the fallback badge rendering. */
  seed: string;
  label: string;
  size?: BadgeSize;
  rounded?: BadgeRounded;
  /**
   * Override the helper line under the upload button. Defaults to a
   * thumbnail-shaped hint ("Square images work best"); pass something
   * different for a hero / banner uploader where wide aspects are the
   * norm.
   */
  hint?: string;
}

const PRESIGN_ENDPOINT = '/api/portal/storage/presign-upload';
const MAX_MB = 5;

/**
 * Thin wrapper around the presign → PUT → persist flow. Responsibilities:
 *   1. Ask portal-api for a presigned MinIO PUT URL.
 *   2. PUT the file bytes directly to MinIO (never through our API).
 *   3. Call onChange with the resulting public URL so the parent can
 *      persist it on the owning entity via its own PATCH endpoint.
 *
 * The parent owns persistence. That keeps the uploader context-free:
 * we don't care whether the new URL is saved to an item, group, or
 * user, just that the parent knows what to do with it.
 */
export function ImageUploader({
  kind,
  value,
  onChange,
  seed,
  label,
  size = 'xl',
  rounded = 'md',
  hint,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);

    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Image is too large. Max is ${MAX_MB} MB.`);
      return;
    }

    setBusy(true);
    try {
      // 1. Ask the API to mint a presigned PUT.
      const presignRes = await fetch(PRESIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, contentType: file.type }),
      });
      if (!presignRes.ok) {
        setError(`Could not start upload: ${presignRes.status}`);
        return;
      }
      const { uploadUrl, publicUrl } = (await presignRes.json()) as {
        uploadUrl: string;
        publicUrl: string;
      };

      // 2. PUT directly to MinIO. Browser → storage, never through Node.
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!putRes.ok) {
        setError(`Upload failed: ${putRes.status}`);
        return;
      }

      // 3. Hand the URL back to the parent for persistence.
      onChange(publicUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-4">
      <div className="shrink-0">
        <EntityBadge
          label={label}
          seed={seed}
          imageUrl={value}
          size={size}
          rounded={rounded}
        />
      </div>

      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
          }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {busy ? 'Uploading' : value ? 'Replace' : 'Upload image'}
          </button>
          {value ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-danger shadow-card hover:bg-danger/5 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </button>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          {hint ??
            `PNG, JPEG, WebP, or GIF. Up to ${MAX_MB} MB. Square images work best.`}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
