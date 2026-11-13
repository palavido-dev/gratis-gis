// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads the body of `POST items/:id/layers/:layerId/import`.
//
// That endpoint answers with newline-delimited JSON: a `start` line,
// any number of `progress` lines, then exactly one terminal line,
// `done` or `error`. Once the first line is out the status is already
// 200, so a failure part way through is only visible as an `error`
// line. Parsing the whole body as one JSON document fails on every
// successful import (two or more lines) and accepts a lone error line
// as if it were the result, which is why callers go through here.

export interface ImportStreamDone {
  event: 'done';
  driver: string;
  sourceLayer: string | null;
  inserted: number;
  mode: 'replace' | 'append';
  replaced?: number;
}

export class ImportStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportStreamError';
  }
}

const FALLBACK_MESSAGE = 'The import did not finish.';

/** Parses each non-empty line; lines that are not JSON are skipped. */
function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    } catch {
      // A truncated last line (connection dropped) is not JSON. It is
      // handled below as "no terminal event".
    }
  }
  return out;
}

/**
 * Returns the `done` event of an import stream, or throws an
 * ImportStreamError carrying the server's message when the stream
 * ended with `error` or ended without a terminal event at all.
 */
export function readImportStreamResult(text: string): ImportStreamDone {
  const events = parseLines(text);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.event === 'error') {
      throw new ImportStreamError(
        typeof ev.message === 'string' && ev.message
          ? ev.message
          : FALLBACK_MESSAGE,
      );
    }
    if (ev.event === 'done') {
      return {
        event: 'done',
        driver: typeof ev.driver === 'string' ? ev.driver : '',
        sourceLayer:
          typeof ev.sourceLayer === 'string' ? ev.sourceLayer : null,
        inserted: typeof ev.inserted === 'number' ? ev.inserted : 0,
        mode: ev.mode === 'append' ? 'append' : 'replace',
        ...(typeof ev.replaced === 'number' ? { replaced: ev.replaced } : {}),
      };
    }
  }
  throw new ImportStreamError(FALLBACK_MESSAGE);
}

/**
 * Message for a non-2xx import response. A rejection before the
 * stream starts still carries one `error` line (or a Nest JSON error)
 * as its body; this pulls the readable message out of either.
 */
export function importStreamErrorText(
  status: number,
  text: string,
): string {
  for (const ev of parseLines(text).reverse()) {
    if (typeof ev.message === 'string' && ev.message) return ev.message;
  }
  return `Import failed (${status}).`;
}
