// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local previews for form attachments uploaded while online.
 *
 * An uploaded answer's `url` is the private attachment route, which
 * only serves a key once a submission has registered it. Until then a
 * photo thumbnail or a clip player pointed at it got a 404, and a
 * clip's duration could not be read. The form runtime keeps an object
 * URL of the picked file per storage key here instead, and shows that.
 * It lives in runtime state only, never in the stored answer, and is
 * released when the form is submitted or closed.
 */

export interface PreviewableEntry {
  url?: unknown;
  key?: unknown;
  dataUrl?: unknown;
}

export class LocalPreviews {
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
    private readonly revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  /** Keep a local copy for an uploaded key; returns its object URL. */
  remember(key: string, blob: Blob): string {
    const old = this.urls.get(key);
    if (old) this.revoke(old);
    const url = this.create(blob);
    this.urls.set(key, url);
    return url;
  }

  /** What to show for an answer: the local copy when this device
   *  uploaded it, else its url, else its inline bytes. */
  srcFor(entry: PreviewableEntry): string {
    if (typeof entry.key === 'string') {
      const local = this.urls.get(entry.key);
      if (local) return local;
    }
    if (typeof entry.url === 'string') return entry.url;
    return typeof entry.dataUrl === 'string' ? entry.dataUrl : '';
  }

  /** Release every object URL. */
  clear(): void {
    for (const url of this.urls.values()) this.revoke(url);
    this.urls.clear();
  }
}
