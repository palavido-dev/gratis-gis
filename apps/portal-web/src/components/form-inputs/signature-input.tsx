// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Signature pad for the `signature` question.
 *
 * The answer is an attachment, not a bare data URL: an array holding
 * one `{ name, mimeType, sizeBytes, dataUrl }` entry, the same pending
 * shape PhotoInput writes when it is offline. That buys everything the
 * photo path already does for free:
 *
 *   - the respond page queues every submission and, while draining,
 *     uploads pending attachments to object storage and swaps each
 *     one for its `{ url, key }` descriptor
 *     (uploadPendingAttachmentsInResponse), so the PNG never sits in
 *     the response JSON once it is online;
 *   - the API registers the uploaded descriptor as an attachment
 *     (forms.service extractAttachments);
 *   - the responses view already renders signature answers through
 *     the shared attachment list.
 *
 * Nothing is uploaded per stroke. A signature is a few dozen strokes,
 * and the drain uploads the final image once.
 *
 * The canvas is painted white before any ink so the exported PNG reads
 * the same in a dark-themed portal, a PDF report, or an email.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

interface SignatureAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl?: string;
  url?: string;
  key?: string;
}

interface Props {
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
  labels: {
    aria: string;
    hint: string;
    clear: string;
    signed: string;
  };
}

/** Internal buffer. 3:1 is the usual signature-line shape. */
const W = 900;
const H = 300;
const INK = '#111827';

/** Read the existing answer, tolerating a legacy bare data URL. */
export function signatureSrc(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('data:image/')) return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as SignatureAttachment | null;
  if (!first || typeof first !== 'object') return null;
  if (typeof first.url === 'string') return first.url;
  if (typeof first.dataUrl === 'string') return first.dataUrl;
  return null;
}

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function paintBlank(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Signature line, so a respondent knows where to sign.
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, H - 60);
  ctx.lineTo(W - 40, H - 60);
  ctx.stroke();
  ctx.restore();
}

export function SignatureInput({ value, readOnly, onChange, labels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const inked = useRef(false);
  /** The data URL this pad last emitted, so its own echo is not
   *  repainted (which would flash the pad blank while it reloads). */
  const emitted = useRef<string | null>(null);
  const existing = signatureSrc(value);
  const [hasValue, setHasValue] = useState(existing !== null);

  // Paint the saved answer when it changes from outside (opening an
  // existing record, a draft restore, clearing). The pad's own strokes
  // come back through here as the new value and are skipped.
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    setHasValue(existing !== null);
    if (drawing.current) return;
    if (existing !== null && existing === emitted.current) return;
    paintBlank(ctx);
    if (!existing) {
      inked.current = false;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      inked.current = true;
    };
    img.src = existing;
  }, [existing]);

  function toCanvas(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (readOnly) return;
    e.preventDefault();
    drawing.current = true;
    last.current = toCanvas(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    // A tap with no movement still leaves a dot.
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && last.current) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(last.current.x, last.current.y, 1.75, 0, Math.PI * 2);
      ctx.fill();
      inked.current = true;
    }
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (readOnly || !drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const next = toCanvas(e);
    if (last.current) {
      // Pressure-aware width on pens; fingers and mice report 0.5.
      const p = e.pressure > 0 ? e.pressure : 0.5;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2 + p * 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      inked.current = true;
    }
    last.current = next;
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const c = canvasRef.current;
    if (!c || !inked.current) return;
    const dataUrl = c.toDataURL('image/png');
    emitted.current = dataUrl;
    setHasValue(true);
    onChange([
      {
        name: 'signature.png',
        mimeType: 'image/png',
        sizeBytes: dataUrlBytes(dataUrl),
        dataUrl,
      },
    ]);
  }

  function clear() {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) paintBlank(ctx);
    inked.current = false;
    emitted.current = null;
    setHasValue(false);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        role="img"
        aria-label={labels.aria}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        style={{ aspectRatio: `${W} / ${H}`, touchAction: 'none' }}
        className={`block w-full rounded-md border border-border bg-white ${
          readOnly ? '' : 'cursor-crosshair'
        }`}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-muted">
          {hasValue ? labels.signed : readOnly ? null : labels.hint}
        </p>
        {!readOnly && hasValue ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {labels.clear}
          </button>
        ) : null}
      </div>
    </div>
  );
}
