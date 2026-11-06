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
 * When online, the finished image is also uploaded straight away, the
 * way PhotoInput uploads a photo, and the answer becomes the uploaded
 * descriptor. That matters outside the respond page: the field app
 * saves form answers as feature properties, and a pending data URL
 * there would otherwise sit in the row as base64. Nothing is uploaded
 * per stroke: the upload waits until the pen has rested for a moment
 * (UPLOAD_IDLE_MS), and an upload overtaken by a later stroke or a
 * clear is dropped. Until it lands, and whenever it fails or there is
 * no signal, the answer stays pending for the queue drain to upload.
 *
 * The canvas is painted white before any ink so the exported PNG reads
 * the same in a dark-themed portal, a PDF report, or an email.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { uploadFormAttachment } from '@/lib/form-attachment-upload';
import {
  SIGNATURE_FILE_NAME,
  SIGNATURE_MIME,
  pendingSignature,
  signatureSrc,
} from '@/lib/signature';

/** How long the pen must rest before the image is uploaded. */
const UPLOAD_IDLE_MS = 1200;

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
  /** Bumped by every stroke and clear, so an upload that a later
   *  change overtook can tell and drop its result. */
  const version = useRef(0);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  function cancelUpload() {
    if (uploadTimer.current) {
      clearTimeout(uploadTimer.current);
      uploadTimer.current = null;
    }
  }

  useEffect(() => cancelUpload, []);

  /** Upload the pad's image once the pen has rested; online only. */
  function scheduleUpload(dataUrl: string) {
    cancelUpload();
    if (typeof navigator === 'undefined' || !navigator.onLine) return;
    const v = version.current;
    uploadTimer.current = setTimeout(() => {
      uploadTimer.current = null;
      void (async () => {
        try {
          const blob = await fetch(dataUrl).then((r) => r.blob());
          const file = new File([blob], SIGNATURE_FILE_NAME, { type: SIGNATURE_MIME });
          const uploaded = await uploadFormAttachment(file);
          if (version.current !== v) return; // overtaken by a stroke or a clear
          // The pad already shows this image; do not repaint it.
          emitted.current = uploaded.url;
          onChange([uploaded]);
        } catch {
          // Stays pending: the queue drain uploads it later.
        }
      })();
    }, UPLOAD_IDLE_MS);
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (readOnly) return;
    e.preventDefault();
    version.current += 1;
    cancelUpload();
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
    const dataUrl = c.toDataURL(SIGNATURE_MIME);
    emitted.current = dataUrl;
    setHasValue(true);
    onChange(pendingSignature(dataUrl));
    scheduleUpload(dataUrl);
  }

  function clear() {
    version.current += 1;
    cancelUpload();
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
