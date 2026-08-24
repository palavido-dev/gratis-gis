// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { CopyButton } from '@/components/ui/copy-button';

/**
 * Copy-URL pill for the File item detail page.
 *
 * Why this exists at all: authors building Custom Web Apps need to
 * embed images / logos / supporting documents stored as File items.
 * The previous path was "open the file item in a new tab, copy the
 * address bar OR right-click on the preview image and Copy Image
 * Address." That's discoverable only after you've done it once. A
 * Copy URL button on the detail page makes the workflow obvious and
 * stays consistent with the eventual File-item picker in widget
 * config UIs.
 *
 * The clipboard mechanics moved to the shared CopyButton when the
 * item detail page grew copyable identifiers of its own; this stays
 * as the named, labelled wrapper the file page reads better with.
 */
export function CopyUrlButton({ url }: { url: string }) {
  return <CopyButton value={url} label="Copy URL" title="Copy public URL" />;
}
