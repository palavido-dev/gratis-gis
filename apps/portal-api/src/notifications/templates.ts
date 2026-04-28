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

/** Payload shape for share_expiring + share_expired. The cron carries
 *  the share's identifying tuple (itemId + principalType + principalId)
 *  so the idempotency lookup can find prior notifications, plus the
 *  exact expiresAt so a re-extension of the share triggers a fresh
 *  warning. */
export interface ShareExpiryPayload {
  itemId: string;
  itemTitle: string;
  itemType: string;
  /** ISO timestamp at which (or after which) the share lapses. */
  expiresAt: string;
  /** The share's principal -- needed for idempotency and for the
   *  human "you no longer have access" framing in the email body. */
  principalType: 'user' | 'group';
  principalId: string;
}

/** Payload shape for user_auto_disable_warning + user_disabled. */
export interface UserDisablePayload {
  /** ISO timestamp at which the auto-disable will fire (warning) or
   *  fired (disabled). Used by the idempotency check + the email
   *  body. */
  autoDisableAt: string;
}

/** Payload shape for editor_feature_created. The editor's owner is
 *  the immediate recipient; a richer per-target recipient list is a
 *  Phase 2b extension. */
export interface EditorFeatureCreatedPayload {
  editorId: string;
  editorTitle: string;
  /** The data_layer the feature landed in. */
  dataLayerId: string;
  dataLayerTitle: string;
  /** Layer key inside the data_layer. */
  layerKey: string;
  /** global_id of the new feature. */
  featureId: string;
  /** Display name of the author who created the feature. */
  createdByName: string;
  /** Best-effort summary string -- the first non-empty user field's
   *  value, e.g. "Building #4127". Falls back to a truncated
   *  featureId when nothing better is available. */
  summary: string;
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

  share_expiring: ((payload: ShareExpiryPayload, ctx) => {
    const itemUrl = `${ctx.baseUrl}/items/${payload.itemId}`;
    const when = formatDate(payload.expiresAt);
    const subject = `Your access to "${payload.itemTitle}" expires soon`;
    const text =
      `Your access to "${payload.itemTitle}" on ${ctx.orgLabel} expires on ${when}.\n\n` +
      `If you still need this item, ask the owner to extend the share.\n\n` +
      `Open it: ${itemUrl}\n`;
    const html =
      `<p>Your access to <strong>${escapeHtml(payload.itemTitle)}</strong> on ` +
      `${escapeHtml(ctx.orgLabel)} expires on <strong>${escapeHtml(when)}</strong>.</p>` +
      `<p>If you still need this item, ask the owner to extend the share.</p>` +
      `<p><a href="${escapeAttr(itemUrl)}">Open the item</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  share_expired: ((payload: ShareExpiryPayload, ctx) => {
    const when = formatDate(payload.expiresAt);
    const subject = `Your access to "${payload.itemTitle}" has expired`;
    const text =
      `Your access to "${payload.itemTitle}" on ${ctx.orgLabel} expired on ${when}.\n\n` +
      `You can no longer open or query this item. If you need access, contact the owner.\n`;
    const html =
      `<p>Your access to <strong>${escapeHtml(payload.itemTitle)}</strong> on ` +
      `${escapeHtml(ctx.orgLabel)} expired on <strong>${escapeHtml(when)}</strong>.</p>` +
      `<p>You can no longer open or query this item. If you need access, contact the owner.</p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  user_auto_disable_warning: ((payload: UserDisablePayload, ctx) => {
    const when = formatDate(payload.autoDisableAt);
    const subject = `Your account on ${ctx.orgLabel} will be disabled on ${when}`;
    const text =
      `Your account on ${ctx.orgLabel} is scheduled to be disabled on ${when}.\n\n` +
      `If you still need access, sign in once before that date or contact your org admin.\n\n` +
      `${ctx.baseUrl}\n`;
    const html =
      `<p>Your account on <strong>${escapeHtml(ctx.orgLabel)}</strong> is scheduled to be ` +
      `disabled on <strong>${escapeHtml(when)}</strong>.</p>` +
      `<p>If you still need access, sign in once before that date or contact your org admin.</p>` +
      `<p><a href="${escapeAttr(ctx.baseUrl)}">${escapeHtml(ctx.baseUrl)}</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  user_disabled: ((payload: UserDisablePayload, ctx) => {
    const when = formatDate(payload.autoDisableAt);
    const subject = `Your account on ${ctx.orgLabel} has been disabled`;
    const text =
      `Your account on ${ctx.orgLabel} was disabled on ${when}.\n\n` +
      `Contact your org admin if you believe this was in error.\n`;
    const html =
      `<p>Your account on <strong>${escapeHtml(ctx.orgLabel)}</strong> was disabled on ` +
      `<strong>${escapeHtml(when)}</strong>.</p>` +
      `<p>Contact your org admin if you believe this was in error.</p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  editor_feature_created: ((payload: EditorFeatureCreatedPayload, ctx) => {
    const editorUrl = `${ctx.baseUrl}/items/${payload.editorId}`;
    const dataLayerUrl = `${ctx.baseUrl}/items/${payload.dataLayerId}`;
    const subject = `New submission on "${payload.editorTitle}": ${payload.summary}`;
    const text =
      `${payload.createdByName} added a feature through "${payload.editorTitle}".\n\n` +
      `Layer: ${payload.dataLayerTitle}\n` +
      `Summary: ${payload.summary}\n\n` +
      `Editor: ${editorUrl}\n` +
      `Data layer: ${dataLayerUrl}\n`;
    const html =
      `<p><strong>${escapeHtml(payload.createdByName)}</strong> added a feature ` +
      `through <strong>${escapeHtml(payload.editorTitle)}</strong>.</p>` +
      `<ul>` +
      `<li>Layer: ${escapeHtml(payload.dataLayerTitle)}</li>` +
      `<li>Summary: ${escapeHtml(payload.summary)}</li>` +
      `</ul>` +
      `<p><a href="${escapeAttr(editorUrl)}">Open the editor</a> · ` +
      `<a href="${escapeAttr(dataLayerUrl)}">open the data layer</a></p>`;
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
