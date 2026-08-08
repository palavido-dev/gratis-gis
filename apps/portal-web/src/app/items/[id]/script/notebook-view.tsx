// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Renders an executed notebook: markdown, code, and outputs.
 *
 * ## Why this is hand-rolled and deliberately narrow
 *
 * A notebook output is a MIME bundle, and among the types Jupyter
 * defines are `text/html` and `application/javascript`. A notebook is
 * user-authored content that another user opens in their own session.
 * Rendering either of those, or handing the bundle to a general-purpose
 * notebook renderer that does, is stored cross-site scripting with
 * extra steps: write a notebook, share the script, wait for an admin to
 * read the run.
 *
 * So this is an allowlist, and everything not on it is shown as the
 * text the author would have seen in a terminal:
 *
 *   text/plain       as text
 *   image/png, jpeg  as a data URI, with the byte length capped
 *   stream output    as text
 *   error output     as its traceback, with ANSI colour codes stripped
 *   markdown cells   through a tiny formatter, not a markdown library
 *
 * The markdown formatter handles headings, bold, italic, inline code,
 * links, and lists, and escapes everything first. It is smaller than a
 * dependency and it cannot be talked into emitting a tag, which is the
 * property that matters here. `dangerouslySetInnerHTML` does not appear
 * in this file, and should not be added to it.
 */

interface Cell {
  cell_type?: string;
  source?: string[] | string;
  outputs?: Output[];
  execution_count?: number | null;
}

interface Output {
  output_type?: string;
  text?: string[] | string;
  name?: string;
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Refuse to inline anything enormous; a runaway plot should not wedge
 *  the tab it is being read in. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const joinSource = (src: string[] | string | undefined): string =>
  Array.isArray(src) ? src.join('') : (src ?? '');

/** Jupyter tracebacks carry ANSI colour; strip it rather than print it. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

export function NotebookView({ source }: { source: string }) {
  const parsed = useMemo(() => {
    try {
      const nb = JSON.parse(source) as { cells?: Cell[] };
      return Array.isArray(nb.cells) ? nb.cells : null;
    } catch {
      return null;
    }
  }, [source]);

  if (!parsed) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-ink-1">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <span>
          This run produced something that is not a readable notebook. The
          log below is still the full output.
        </span>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {parsed.map((cell, i) => (
        <CellView key={i} cell={cell} />
      ))}
    </div>
  );
}

function CellView({ cell }: { cell: Cell }) {
  const text = joinSource(cell.source);
  if (cell.cell_type === 'markdown') {
    return <Markdown text={text} />;
  }
  if (cell.cell_type !== 'code') return null;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {text.trim() ? (
        <pre className="overflow-x-auto bg-surface-0 p-3 font-mono text-xs leading-relaxed text-ink-0">
          {text}
        </pre>
      ) : null}
      {(cell.outputs ?? []).map((out, i) => (
        <OutputView key={i} out={out} />
      ))}
    </div>
  );
}

function OutputView({ out }: { out: Output }) {
  if (out.output_type === 'error') {
    const trace = (out.traceback ?? []).join('\n').replace(ANSI, '');
    return (
      <pre className="overflow-x-auto border-t border-border bg-danger/5 p-3 font-mono text-xs leading-relaxed text-danger">
        {trace || `${out.ename ?? 'Error'}: ${out.evalue ?? ''}`}
      </pre>
    );
  }

  if (out.output_type === 'stream') {
    return (
      <pre className="overflow-x-auto border-t border-border bg-surface-1 p-3 font-mono text-xs leading-relaxed text-ink-1">
        {joinSource(out.text)}
      </pre>
    );
  }

  const data = out.data ?? {};

  for (const mime of ['image/png', 'image/jpeg'] as const) {
    const raw = data[mime];
    if (typeof raw === 'string') {
      const b64 = raw.replace(/\s+/g, '');
      if (b64.length > MAX_IMAGE_BYTES) {
        return (
          <p className="border-t border-border bg-surface-1 px-3 py-2 text-xs text-muted">
            An image too large to show inline.
          </p>
        );
      }
      return (
        <div className="border-t border-border bg-surface-0 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:${mime};base64,${b64}`}
            alt="Notebook output"
            className="max-w-full"
          />
        </div>
      );
    }
  }

  const plain = data['text/plain'];
  if (plain !== undefined) {
    return (
      <pre className="overflow-x-auto border-t border-border bg-surface-1 p-3 font-mono text-xs leading-relaxed text-ink-1">
        {joinSource(plain as string[] | string)}
      </pre>
    );
  }

  // Something we will not render: HTML, JavaScript, a widget, a custom
  // MIME type from some library. Say so rather than showing a blank,
  // so nobody concludes their cell produced nothing.
  const types = Object.keys(data);
  if (types.length === 0) return null;
  return (
    <p className="border-t border-border bg-surface-1 px-3 py-2 text-xs text-muted">
      Output not shown here ({types.join(', ')}). Download the notebook to
      see it.
    </p>
  );
}

/**
 * The smallest markdown that makes prose readable.
 *
 * Escapes first, then applies a fixed set of patterns to the escaped
 * text, so no input can produce a tag that was not put there by this
 * function. Anything it does not understand stays as literal text,
 * which is the correct failure for documentation.
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 px-1 text-sm leading-relaxed text-ink-1">
      {blocks.map((block, i) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(block.trim());
        if (heading) {
          const level = heading[1]!.length;
          const size =
            level === 1
              ? 'text-base font-semibold text-ink-0'
              : level === 2
                ? 'text-sm font-semibold text-ink-0'
                : 'text-sm font-medium text-ink-0';
          return (
            <p key={i} className={size}>
              {inline(heading[2] ?? '')}
            </p>
          );
        }
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(block)}</p>;
      })}
    </div>
  );
}

/**
 * Inline formatting, returned as React nodes rather than a string.
 *
 * React escapes every string it renders, so building an array of
 * elements means the output cannot contain markup by construction. A
 * regex that produced an HTML string would put us one
 * `dangerouslySetInnerHTML` away from the hole this file exists to
 * avoid.
 */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-surface-2 px-1 font-mono text-[0.9em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink-0">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*')) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link?.[2] ?? '';
      // Only http(s). A `javascript:` href is the other way a link
      // becomes script execution, and it is easy to forget.
      const safe = /^https?:\/\//i.test(href);
      parts.push(
        safe ? (
          <a
            key={key++}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent underline"
          >
            {link?.[1]}
          </a>
        ) : (
          <span key={key++}>{link?.[1] ?? token}</span>
        ),
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
