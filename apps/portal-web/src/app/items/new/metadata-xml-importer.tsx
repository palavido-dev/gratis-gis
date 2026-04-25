'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, Check, FileCode, Upload } from 'lucide-react';

import {
  parseMetadataXml,
  type ParsedMetadata,
} from '@/lib/metadata-xml';

interface Props {
  /**
   * Fires once with whatever fields were extracted from the parsed
   * XML. The wizard merges these into its existing form state; only
   * the fields the parser actually populated come through, so a
   * sparse XML never wipes a user-typed title.
   */
  onApply: (next: {
    title?: string;
    description?: string;
    tags?: string[];
    license?: string;
    bbox?: [number, number, number, number];
  }) => void;
}

/**
 * Optional metadata XML importer for the new-item wizard. Lets an
 * operator drop an ISO 19115 / FGDC CSDGM / Dublin Core file and
 * have the wizard's title / description / tags pre-filled. The
 * actual creation still goes through the same POST flow; this is
 * a pure form-prefill convenience.
 *
 * Browser-side parsing keeps the API out of the loop and makes a
 * dropped file feel snappy. The supported formats are catalogued in
 * `apps/portal-web/src/lib/metadata-xml.ts`.
 */
export function MetadataXmlImporter({ onApply }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'parsed'; meta: ParsedMetadata }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function handleFile(file: File) {
    try {
      const text = await file.text();
      const meta = parseMetadataXml(text);
      if (meta.source === 'unknown') {
        setStatus({
          kind: 'error',
          message:
            'Got an XML file but it does not look like ISO 19115, FGDC CSDGM, or Dublin Core. Skipping.',
        });
        return;
      }
      onApply({
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.description !== undefined
          ? { description: meta.description }
          : {}),
        ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
        ...(meta.license !== undefined ? { license: meta.license } : {}),
        ...(meta.bbox !== undefined ? { bbox: meta.bbox } : {}),
      });
      setStatus({ kind: 'parsed', meta });
    } catch (err) {
      setStatus({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Could not read that file.',
      });
    }
  }

  return (
    <section className="rounded-md border border-dashed border-border bg-surface-0 p-3">
      <input
        ref={inputRef}
        type="file"
        accept=".xml,application/xml,text/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <FileCode className="h-4 w-4 text-muted" />
        <span className="text-xs text-ink-1">
          Have a metadata XML file? Drop it in to pre-fill the title,
          description, and tags below.
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          <Upload className="h-3.5 w-3.5" />
          Pick a file
        </button>
      </div>
      {status.kind === 'parsed' ? (
        <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-success">
          <Check className="h-3 w-3" />
          Parsed as {labelFor(status.meta.source)}. Filled what we
          could; the rest is yours.
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <p
          role="alert"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-danger"
        >
          <AlertTriangle className="h-3 w-3" />
          {status.message}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted">
        Supported: ISO 19115 / 19139, FGDC CSDGM, Dublin Core. Your
        file stays in the browser.
      </p>
    </section>
  );
}

function labelFor(source: ParsedMetadata['source']): string {
  switch (source) {
    case 'iso19115':
      return 'ISO 19115';
    case 'fgdc':
      return 'FGDC CSDGM';
    case 'dublin-core':
      return 'Dublin Core';
    default:
      return 'unknown';
  }
}
