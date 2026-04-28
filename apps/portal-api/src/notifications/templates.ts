import { NotificationType } from '@prisma/client';

/**
 * Per-NotificationType template registry. Each entry produces the
 * subject + body the worker hands to the SMTP transport. Templates
 * are pure functions of payload + a small `RenderContext` (the org
 * label, base URL, etc) so they're trivial to unit-test and don't
 * reach into the database.
 *
 * Payload shapes documented per type below. Adding a new
 * NotificationType is a two-step change: extend the schema enum +
 * the entry in this map. The worker treats unknown types as a
 * no-op delete (the row gets marked `failed` with a clear error
 * rather than breaking the queue) so a forward-rolled deploy that
 * lacks an entry doesn't poison the worker for everyone else.
 *
 * Phase 1 ships `share_created` only; the rest of the entries land
 * with the matching trigger commit and exist here as registry
 * placeholders until then.
 */

export interface RenderContext {
  /** Org name shown in subject + footer. Defaults to "GratisGIS". */
  orgLabel: string;
  /** Public-facing base URL. Used to build deep links into the
   *  portal so the recipient can click straight into the affected
   *  item / share / page. Comes from PORTAL_BASE_URL env. */
  baseUrl: string;
}

export interface RenderedNotification {
  subject: string;
  text: string;
  html: string;
}

/**
 * Payload shape for `share_created`. Captured at trigger time in
 * items.service.ts share().
 */
export interface ShareCreatedPayload {
  itemId: string;
  itemTitle: string;
  itemType: string;
  permission: 'view' | 'download' | 'edit' | 'admin';
  /** Display name of the author who shared (e.g. "Bob Example"). */
  sharedByName: string;
  /** Optional ISO expiry; rendered when present. */
  expiresAt?: string;
}

type Renderer<T> = (payload: T, ctx: RenderContext) => RenderedNotification;

const renderers: { [K in NotificationType]?: Renderer<unknown> } = {
  share_created: ((payload: ShareCreatedPayload, ctx) => {
    const itemUrl = `${ctx.baseUrl}/items/${payload.itemId}`;
    const expiryNote = payload.expiresAt
      ? ` (access expires ${formatDate(payload.expiresAt)})`
      : '';
    const subject = `${payload.sharedByName} shared "${payload.itemTitle}" with you`;
    const text =
      `${payload.sharedByName} shared "${payload.itemTitle}" with you on ${ctx.orgLabel}.\n\n` +
      `Item type: ${humanizeType(payload.itemType)}\n` +
      `Permission: ${payload.permission}${expiryNote}\n\n` +
      `Open it: ${itemUrl}\n`;
    const html =
      `<p><strong>${escapeHtml(payload.sharedByName)}</strong> shared ` +
      `<strong>${escapeHtml(payload.itemTitle)}</strong> with you on ` +
      `${escapeHtml(ctx.orgLabel)}.</p>` +
      `<ul>` +
      `<li>Item type: ${escapeHtml(humanizeType(payload.itemType))}</li>` +
      `<li>Permission: ${escapeHtml(payload.permission)}${escapeHtml(expiryNote)}</li>` +
      `</ul>` +
      `<p><a href="${escapeAttr(itemUrl)}">Open the item</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,
};

/**
 * Render a notification for delivery. Returns null when the type
 * has no registered renderer (worker treats this as "fail with a
 * clear reason rather than crash").
 */
export function renderNotification(
  type: NotificationType,
  payload: unknown,
  ctx: RenderContext,
): RenderedNotification | null {
  const r = renderers[type];
  if (!r) return null;
  return r(payload, ctx);
}

// ----- helpers -----

function humanizeType(t: string): string {
  // Item type DB values are kebab-case; render as space-separated
  // for the email body. "data-layer" -> "Data layer".
  const spaced = t.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  // Slightly different from escapeHtml: attribute context can't
  // tolerate raw newlines, and we already escape quotes.
  return escapeHtml(s).replace(/\n/g, ' ');
}
