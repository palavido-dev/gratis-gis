// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * AssetPicker — unified UI for "give me a URL to an image / file"
 * across the portal. Three modes:
 *
 *   1. Paste URL: text input. Stored as `{ kind: 'external-url' }`.
 *   2. Pick from File items: dialog with the org's File items
 *      filtered by MIME. Stored as `{ kind: 'file-item', itemId }`
 *      with denormalized cachedUrl + cachedFileName so server-render
 *      paths can embed without a fresh fetch.
 *   3. Upload new: file input that uploads to MinIO via the
 *      existing presign endpoint AND creates a File item so the
 *      asset is governed (provenance, sharing, lifecycle) instead
 *      of being a floating URL. Emits a file-item AssetRef pointing
 *      at the newly-created item.
 *
 * Why always create a File item on upload: floating asset URLs are
 * impossible to govern. You can't tell which apps depend on a
 * file, you can't replace the bytes without editing every config,
 * you can't share-control who sees the asset. A File item per
 * upload pays a small bookkeeping cost and gives you the full
 * portal model on top.
 *
 * The picker emits a single AssetRef to its caller via onChange.
 * Existing call sites that store `url?: string` can convert by
 * mapping `null -> undefined` for the URL form and resolving
 * file-item refs at render time.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AssetRef, FileData, Item } from '@gratis-gis/shared-types';

interface Props {
  /** Current asset reference. */
  value: AssetRef | null;
  /** Called with the new reference when the author picks / uploads /
   *  pastes. `null` clears the asset. */
  onChange: (next: AssetRef | null) => void;
  /**
   * MIME-type prefixes the picker accepts. Filters the file-item
   * list to matching items and the upload `accept=` attribute.
   * Defaults to `['image/']` (the common case).
   */
  acceptMimePrefixes?: string[];
  /** Maximum upload size in megabytes. Defaults to 10 MB. */
  maxMb?: number;
  /** Disable interaction (read-only). */
  disabled?: boolean;
  /** Optional label shown above the picker. */
  label?: string;
  /** Optional helper text under the picker. */
  hint?: string;
  /**
   * Asset kind passed through to the presigned-upload endpoint to
   * shape the MinIO storage path. Defaults to 'item-thumb' which is
   * a permissive existing path; specialize for new use cases.
   */
  uploadKind?: 'item-thumb' | 'group-thumb' | 'user-avatar' | 'org-hero';
}

const PRESIGN_ENDPOINT = '/api/portal/storage/presign-upload';
// `lite=1` strips `data` from the server response to save
// bandwidth on the items grid.  We CANNOT use lite here: the
// picker filters by `data.mimeType` to surface only images (or
// whatever the caller asked for), and the only fallback when
// mimeType is missing is matching the file extension against the
// item title -- which works for `logo.png` but misses titles like
// "Site logo" that the user typed in.  Without the data blob the
// filter dropped every File item that didn't happen to have an
// extension in its title, so the picker came up empty.  Asking
// for the full payload keeps the picker honest.
// full=1: see above; the mime filter needs data, and the items
// list strips data_json by default now.
const FILE_LIST_ENDPOINT = '/api/portal/items?type=file&full=1';

export function AssetPicker({
  value,
  onChange,
  acceptMimePrefixes = ['image/'],
  maxMb = 10,
  disabled = false,
  label,
  hint,
  uploadKind = 'item-thumb',
}: Props) {
  // Active sub-mode: which input is the author currently typing
  // into. Defaults to 'preview' so the picker shows the current
  // asset (if any) plus three switcher buttons; clicking a button
  // expands the corresponding input.
  const [mode, setMode] = useState<'preview' | 'paste-url' | 'pick-existing' | 'uploading'>(
    'preview',
  );
  const [urlDraft, setUrlDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Resolve the current value to a displayable URL + filename.
  // file-item refs use the cached values when available; the picker
  // doesn't refetch on each render because callers can pre-warm
  // the cache when they load existing apps.
  const currentUrl =
    value?.kind === 'external-url'
      ? value.url
      : value?.kind === 'file-item'
        ? value.cachedUrl ?? null
        : null;
  const currentLabel =
    value?.kind === 'file-item'
      ? value.cachedFileName ?? `File ${value.itemId.slice(0, 8)}`
      : value?.kind === 'external-url'
        ? new URL(value.url, 'http://placeholder').pathname.split('/').pop() ?? value.url
        : null;

  const pasteId = useId();

  function commitUrl() {
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      setError('Paste a URL.');
      return;
    }
    try {
      new URL(trimmed);
    } catch {
      setError('Not a valid URL.');
      return;
    }
    setError(null);
    onChange({ kind: 'external-url', url: trimmed });
    setUrlDraft('');
    setMode('preview');
  }

  async function uploadAndCreateFileItem(file: File) {
    setError(null);
    // Validate MIME against the prefixes the picker accepts. The
    // file-input's `accept` attribute is a hint, not a hard
    // constraint (users can override it), so we re-check here.
    if (
      acceptMimePrefixes.length > 0 &&
      !acceptMimePrefixes.some((p) => file.type.startsWith(p))
    ) {
      setError(
        `Wrong file type (${file.type || 'unknown'}). Expected ${acceptMimePrefixes.join(', ')}.`,
      );
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      setError(`File too large. Max is ${maxMb} MB.`);
      return;
    }
    setMode('uploading');
    try {
      // 1. Presign + PUT to MinIO (same path the existing
      // ImageUploader uses).
      const presignRes = await fetch(PRESIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: uploadKind, contentType: file.type }),
      });
      if (!presignRes.ok) {
        setError(`Upload start failed: ${presignRes.status}`);
        setMode('preview');
        return;
      }
      const { uploadUrl, publicUrl } = (await presignRes.json()) as {
        uploadUrl: string;
        publicUrl: string;
      };
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!putRes.ok) {
        setError(`Upload failed: ${putRes.status}`);
        setMode('preview');
        return;
      }

      // 2. Create a File item wrapping the uploaded bytes. This is
      // what makes the asset governed (provenance, sharing,
      // lifecycle, item-list visibility). Title defaults to the
      // filename; access defaults to org so the asset can be
      // reused; tags get an 'asset' marker so they're filterable
      // out of the main items list when the user doesn't want to
      // see one-off uploads.
      const itemRes = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'file',
          title: file.name,
          description: '',
          tags: ['asset'],
          access: 'org',
          data: {
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            storageUrl: publicUrl,
            uploadedAt: new Date().toISOString(),
          },
        }),
      });
      if (!itemRes.ok) {
        setError(`File item create failed: ${itemRes.status}`);
        setMode('preview');
        return;
      }
      const created = (await itemRes.json()) as { id?: string };
      if (!created.id) {
        // Defensive: server returned 2xx but no id. Fall back to
        // a bare external-url ref so the upload isn't lost.
        onChange({ kind: 'external-url', url: publicUrl });
        setMode('preview');
        return;
      }
      onChange({
        kind: 'file-item',
        itemId: created.id,
        cachedUrl: publicUrl,
        cachedFileName: file.name,
      });
      setMode('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setMode('preview');
    }
  }

  return (
    <div className="space-y-2">
      {label ? (
        <label className="block text-2xs font-medium uppercase tracking-wide text-muted">
          {label}
        </label>
      ) : null}

      {/* Preview row + action buttons. Shown in 'preview' mode (the
          default) and 'uploading' (with a spinner overlay). */}
      {(mode === 'preview' || mode === 'uploading') && (
        <div className="flex items-stretch gap-2 rounded-md border border-border bg-surface-1 p-2">
          <AssetThumb url={currentUrl} label={currentLabel} />
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
            <div className="min-w-0">
              {value ? (
                <>
                  <p className="truncate text-xs font-medium text-ink-0">
                    {currentLabel ?? 'Asset'}
                  </p>
                  <p className="truncate text-2xs text-muted">
                    {value.kind === 'file-item' ? (
                      <>
                        File item ·{' '}
                        <a
                          href={`/items/${value.itemId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {value.itemId.slice(0, 8)}
                          <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                        </a>
                      </>
                    ) : (
                      <>External URL</>
                    )}
                  </p>
                </>
              ) : (
                <p className="text-xs italic text-muted">No asset selected.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                disabled={disabled || mode === 'uploading'}
                onClick={() => {
                  setError(null);
                  setUrlDraft(value?.kind === 'external-url' ? value.url : '');
                  setMode('paste-url');
                }}
                className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                <LinkIcon className="h-3 w-3" />
                Paste URL
              </button>
              <button
                type="button"
                disabled={disabled || mode === 'uploading'}
                onClick={() => {
                  setError(null);
                  setMode('pick-existing');
                }}
                className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                <ImageIcon className="h-3 w-3" />
                Pick file
              </button>
              <button
                type="button"
                disabled={disabled || mode === 'uploading'}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                {mode === 'uploading' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                {mode === 'uploading' ? 'Uploading…' : 'Upload'}
              </button>
              {value ? (
                <button
                  type="button"
                  disabled={disabled || mode === 'uploading'}
                  onClick={() => {
                    setError(null);
                    onChange(null);
                  }}
                  className="ml-auto inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Paste URL mode. Lightweight inline input rather than a
          dialog -- the affordance is small enough to fit in the
          right-rail. */}
      {mode === 'paste-url' && (
        <div className="space-y-1.5 rounded-md border border-accent bg-surface-1 p-2">
          <label htmlFor={pasteId} className="block text-2xs font-medium text-muted">
            URL
          </label>
          <input
            id={pasteId}
            type="url"
            autoFocus
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitUrl();
              }
              if (e.key === 'Escape') {
                setMode('preview');
              }
            }}
            placeholder="https://example.com/image.png"
            className="h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-2xs"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setMode('preview')}
              className="inline-flex h-7 items-center rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitUrl}
              className="inline-flex h-7 items-center gap-1 rounded bg-accent px-2 text-2xs font-medium text-accent-foreground hover:opacity-90"
            >
              <Check className="h-3 w-3" />
              Use URL
            </button>
          </div>
        </div>
      )}

      {/* Pick-existing mode. Modal-ish overlay with the File item
          list filtered by MIME. */}
      {mode === 'pick-existing' && (
        <FileItemPicker
          acceptMimePrefixes={acceptMimePrefixes}
          onPick={(item) => {
            const data = item.data as FileData | undefined;
            onChange({
              kind: 'file-item',
              itemId: item.id,
              ...(data?.storageUrl ? { cachedUrl: data.storageUrl } : {}),
              ...(data?.fileName ? { cachedFileName: data.fileName } : {}),
            });
            setMode('preview');
          }}
          onClose={() => setMode('preview')}
        />
      )}

      {/* Hidden file input the Upload button clicks. Placed outside
          the conditional render so the ref stays stable. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptMimePrefixes.map((p) => `${p}*`).join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void uploadAndCreateFileItem(file);
          }
          // Reset so picking the same file again still fires onChange.
          e.target.value = '';
        }}
      />

      {error ? (
        <p
          role="alert"
          className="inline-flex items-center gap-1 text-2xs text-danger"
        >
          <AlertTriangle className="h-3 w-3" />
          {error}
        </p>
      ) : null}

      {hint ? <p className="text-2xs text-muted">{hint}</p> : null}
    </div>
  );
}

function AssetThumb({ url, label }: { url: string | null; label: string | null }) {
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-2">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- the
        // upload host (MinIO + external) isn't in next.config; raw
        // <img> avoids forcing operators to whitelist every host.
        <img
          src={url}
          alt={label ?? ''}
          className="h-full w-full object-contain"
          onError={(e) => {
            // Stale cached URL or external dead link. Fall back to
            // a placeholder so the picker doesn't show a broken
            // image icon.
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <ImageIcon className="h-5 w-5 text-muted" />
      )}
    </div>
  );
}

interface FileItemPickerProps {
  acceptMimePrefixes: string[];
  onPick: (item: Item) => void;
  onClose: () => void;
}

/**
 * Modal-style File-item browser. Fetches the org's File items
 * filtered by mimeType, lets the author pick one. Stays compact;
 * search is a single text filter rather than a full grid.
 */
function FileItemPicker({
  acceptMimePrefixes,
  onPick,
  onClose,
}: FileItemPickerProps) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(FILE_LIST_ENDPOINT);
        if (!res.ok) {
          if (!cancelled) setError(`Could not load files (HTTP ${res.status}).`);
          return;
        }
        const raw = (await res.json()) as Item[];
        if (cancelled) return;
        // Filter to items whose data.mimeType matches the accepted
        // prefixes. The list endpoint returns lite items so data
        // may be partial; if mimeType is missing, fall back to
        // matching by filename extension via the title.
        const filtered = raw.filter((it) => {
          const data = it.data as FileData | undefined;
          const mime = data?.mimeType ?? '';
          if (mime && acceptMimePrefixes.some((p) => mime.startsWith(p))) {
            return true;
          }
          // Best-effort fallback when mimeType isn't in the lite
          // payload. For images, recognize common extensions.
          if (acceptMimePrefixes.includes('image/')) {
            const name = (data?.fileName ?? it.title ?? '').toLowerCase();
            return /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(name);
          }
          return false;
        });
        setItems(filtered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load files.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acceptMimePrefixes]);

  const filtered = items?.filter((it) =>
    query ? it.title.toLowerCase().includes(query.toLowerCase()) : true,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Pick a file item"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <ImageIcon className="h-4 w-4 text-muted" />
          <span className="flex-1 text-sm font-semibold text-ink-0">
            Pick a file item
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="shrink-0 border-b border-border px-3 py-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title…"
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <p
              role="alert"
              className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : !items ? (
            <p className="px-3 py-2 text-xs italic text-muted">Loading…</p>
          ) : filtered && filtered.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {filtered.map((it) => {
                const data = it.data as FileData | undefined;
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => onPick(it)}
                      className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-1 p-2 text-left transition-colors hover:border-accent hover:bg-surface-2"
                    >
                      <AssetThumb
                        url={data?.storageUrl ?? null}
                        label={data?.fileName ?? null}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-ink-0">
                          {it.title}
                        </p>
                        <p className="truncate text-2xs text-muted">
                          {data?.fileName ?? '(no filename)'}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-2 text-xs italic text-muted">
              No matching file items in your org. Use Upload to add one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
