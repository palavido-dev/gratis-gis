// SPDX-License-Identifier: AGPL-3.0-or-later
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
  /** Display name of the author who shared (e.g. "Admin User"). */
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

/** Payload shape for `comment_mentioned` (map comment @username). */
export interface CommentMentionedPayload {
  itemId: string;
  itemTitle: string;
  threadId: string;
  commentId: string;
  /** Display name of the author who wrote the mention. */
  mentionedByName: string;
  /** Short plain-text excerpt of the comment body. */
  snippet: string;
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

/** Payload shape for data_collection_feature_created. Mirrors
 *  EditorFeatureCreatedPayload but keys on the data_collection
 *  item id so the trigger path can branch + the recipient resolution
 *  can change later (e.g. notify a per-deployment list rather than
 *  the deployment owner). */
export interface DataCollectionFeatureCreatedPayload {
  dataCollectionId: string;
  dataCollectionTitle: string;
  /** The data_layer the feature landed in. */
  dataLayerId: string;
  dataLayerTitle: string;
  /** Layer key inside the data_layer. */
  layerKey: string;
  /** global_id of the new feature. */
  featureId: string;
  /** Display name of the author who created the feature. */
  createdByName: string;
  /** Best-effort summary string from the first non-empty user field. */
  summary: string;
}

/** Payload shape for form_submission_received. */
export interface FormSubmissionReceivedPayload {
  formItemId: string;
  formTitle: string;
  /** form_submission row id; deep-link target. */
  submissionId: string;
  /** Display name of the submitter. Falls back to "Someone" when
   *  the form is configured for anonymous responses. */
  submittedByName: string;
  /** Best-effort summary from the first answered question. */
  summary: string;
  /**
   * Rendered receipt: every answered question on the form, in
   * presentation order, as `{ label, value }` pairs (#190). Empty /
   * unanswered questions are dropped server-side so the email body
   * is just the things the responder actually filled in. The renderer
   * formats the list as an HTML table. Optional so older queued rows
   * (pre-#190) still render cleanly with just `summary`.
   */
  answers?: Array<{ label: string; value: string }>;
}

/** Payload shape for user_invited. The recipient is the invitee, not
 *  the inviting admin; the renderer pulls the invite link directly
 *  from the realm at trigger time. */
export interface UserInvitedPayload {
  invitedEmail: string;
  invitedByName: string;
  /** One-time-use invite link issued by Keycloak. */
  inviteLink: string;
  /** Optional ISO timestamp when the invite link stops working. */
  expiresAt?: string;
}

/** Payload shape for data_collection_schema_break (#230 Phase A).
 *  Fired when an admin saves a data_layer change that drops a
 *  layer or swaps its geometryType -- both break offline copies
 *  the field has already downloaded. Recipients are deployment
 *  owners of every data_collection that transitively depends on
 *  the changed data_layer. The body summarises which layers
 *  changed so the recipient knows which area to rebuild. */
export interface DataCollectionSchemaBreakPayload {
  /** The data_collection (deployment) item the recipient owns. */
  dataCollectionId: string;
  dataCollectionTitle: string;
  /** The data_layer that changed upstream. */
  dataLayerId: string;
  dataLayerTitle: string;
  /** Display name of the admin who made the change. */
  changedByName: string;
  /** Layer keys that were dropped from the data_layer schema. */
  droppedLayerKeys: string[];
  /** Layer keys whose geometryType changed (e.g. point->polygon). */
  geometryChangedLayerKeys: string[];
}

/**
 * #250: per-type variable manifest exposed to the admin template
 * editor. Each entry describes a placeholder the admin can drop into
 * subject / bodyHtml / bodyText with click-to-insert -- no need to
 * memorize {{itemTitle}} vs {{itemId}}. The shape is intentionally
 * shallow (no nested vars yet) because mustache-lite doesn't support
 * dotted paths anyway.
 */
export interface TemplateVariableDescriptor {
  /** Substitution name as it appears inside `{{...}}`. */
  name: string;
  /** Short human-friendly label for the palette button. */
  label: string;
  /** One-line description shown in the palette button's tooltip. */
  description?: string;
  /** Concrete example value the admin can preview against. Mirrors
   *  the value in SAMPLE_PAYLOADS so what they see in the palette
   *  matches what the live preview substitutes. */
  example?: string;
  /** When true, the variable holds HTML (e.g. a pre-rendered link)
   *  and should be inserted as `{{{name}}}` (raw / unescaped) rather
   *  than `{{name}}`. None of the existing renderers expose any HTML
   *  variables, but the field exists so future templates can. */
  raw?: boolean;
}

/**
 * #250: standard variables available to EVERY type. The runtime
 * always merges these in via RenderContext, so the palette should
 * always offer them too.
 */
const STANDARD_VARIABLES: TemplateVariableDescriptor[] = [
  {
    name: 'orgLabel',
    label: 'Organization name',
    description: 'Your portal\'s display name (PORTAL_NAME env).',
    example: 'GratisGIS',
  },
  {
    name: 'baseUrl',
    label: 'Portal base URL',
    description: 'Public-facing URL prefix for deep links.',
    example: 'https://demo.gratisgis.org',
  },
];

/**
 * #250: per-NotificationType variable manifest. Keys mirror the
 * NotificationType enum + the payload shapes above; values describe
 * each variable for the palette. Adding a new type? Drop an entry
 * here next to the renderer + sample payload entries -- if a type
 * is missing the palette falls back to the standard variables only.
 */
const TYPE_VARIABLES: { [K in NotificationType]?: TemplateVariableDescriptor[] } = {
  share_created: [
    { name: 'itemId', label: 'Item ID', example: '00000000-0000-4000-8000-000000000001' },
    { name: 'itemTitle', label: 'Item title', example: 'City Park Trees' },
    { name: 'itemType', label: 'Item type', example: 'data-layer' },
    {
      name: 'permission',
      label: 'Permission',
      description: 'view / download / edit / admin',
      example: 'view',
    },
    { name: 'sharedByName', label: 'Shared by', example: 'Admin User' },
    {
      name: 'expiresAt',
      label: 'Expires at',
      description: 'ISO timestamp; empty when share has no expiry.',
      example: 'in 7 days',
    },
  ],
  share_expiring: [
    { name: 'itemId', label: 'Item ID' },
    { name: 'itemTitle', label: 'Item title', example: 'City Park Trees' },
    { name: 'itemType', label: 'Item type' },
    { name: 'expiresAt', label: 'Expires at', example: 'in 3 days' },
    { name: 'principalType', label: 'Recipient type', description: 'user or group' },
    { name: 'principalId', label: 'Recipient ID' },
  ],
  share_expired: [
    { name: 'itemId', label: 'Item ID' },
    { name: 'itemTitle', label: 'Item title', example: 'City Park Trees' },
    { name: 'itemType', label: 'Item type' },
    { name: 'expiresAt', label: 'Expired at', example: 'yesterday' },
    { name: 'principalType', label: 'Recipient type' },
    { name: 'principalId', label: 'Recipient ID' },
  ],
  user_auto_disable_warning: [
    {
      name: 'autoDisableAt',
      label: 'Auto-disable date',
      example: 'in 5 days',
    },
  ],
  user_disabled: [
    { name: 'autoDisableAt', label: 'Disabled at', example: 'yesterday' },
  ],
  editor_feature_created: [
    { name: 'editorId', label: 'Editor item ID' },
    { name: 'editorTitle', label: 'Editor title', example: 'Storm Drain Inspection' },
    { name: 'dataLayerId', label: 'Data layer ID' },
    { name: 'dataLayerTitle', label: 'Data layer', example: 'Storm Drains' },
    { name: 'layerKey', label: 'Layer key', example: 'drains' },
    { name: 'featureId', label: 'Feature ID', example: 'drains/123' },
    { name: 'createdByName', label: 'Created by', example: 'Contributor User' },
    {
      name: 'summary',
      label: 'Summary',
      description: 'First non-empty user field on the new feature.',
      example: 'Inspection #4127 (cracked grate)',
    },
  ],
  data_collection_feature_created: [
    { name: 'dataCollectionId', label: 'Deployment ID' },
    {
      name: 'dataCollectionTitle',
      label: 'Deployment',
      example: 'Yard Inspection',
    },
    { name: 'dataLayerId', label: 'Data layer ID' },
    { name: 'dataLayerTitle', label: 'Data layer', example: 'Inspection Points' },
    { name: 'layerKey', label: 'Layer key', example: 'points' },
    { name: 'featureId', label: 'Feature ID', example: 'points/456' },
    { name: 'createdByName', label: 'Created by', example: 'Field Worker' },
    {
      name: 'summary',
      label: 'Summary',
      description: 'First non-empty user field on the new feature.',
      example: 'Point near pool fence',
    },
  ],
  form_submission_received: [
    { name: 'formItemId', label: 'Form item ID' },
    { name: 'formTitle', label: 'Form title', example: 'Volunteer Sign-Up' },
    { name: 'submissionId', label: 'Submission ID' },
    { name: 'submittedByName', label: 'Submitted by', example: 'Visitor' },
    {
      name: 'summary',
      label: 'Summary',
      description: 'First answered question.',
      example: 'jane@example.com',
    },
  ],
  user_invited: [
    {
      name: 'invitedEmail',
      label: 'Invited email',
      example: 'newuser@example.com',
    },
    { name: 'invitedByName', label: 'Invited by', example: 'Admin User' },
    {
      name: 'inviteLink',
      label: 'Invite link',
      description: 'One-time-use link to accept the invite.',
      example: 'https://auth.example.org/...',
    },
    { name: 'expiresAt', label: 'Expires at', example: 'in 7 days' },
  ],
  data_collection_schema_break: [
    { name: 'dataCollectionId', label: 'Deployment ID' },
    {
      name: 'dataCollectionTitle',
      label: 'Deployment',
      example: 'Yard Inspection',
    },
    { name: 'dataLayerId', label: 'Data layer ID' },
    { name: 'dataLayerTitle', label: 'Data layer', example: 'Inspection Points' },
    { name: 'changedByName', label: 'Changed by', example: 'Admin User' },
    {
      name: 'droppedLayerKeys',
      label: 'Dropped layers',
      description: 'Comma-joined list of layer keys removed from the schema.',
      example: 'burrow_points',
    },
    {
      name: 'geometryChangedLayerKeys',
      label: 'Geometry changed',
      description: 'Comma-joined list of layer keys whose geometry type changed.',
      example: '(none)',
    },
  ],
  comment_mentioned: [
    {
      name: 'itemId',
      label: 'Item ID',
      example: '00000000-0000-4000-8000-000000000001',
    },
    { name: 'itemTitle', label: 'Map title', example: 'City Park Review' },
    { name: 'threadId', label: 'Thread ID' },
    { name: 'commentId', label: 'Comment ID' },
    {
      name: 'mentionedByName',
      label: 'Mentioned by',
      example: 'Alice Author',
    },
    {
      name: 'snippet',
      label: 'Comment snippet',
      description: 'Short plain-text excerpt of the comment.',
      example: 'Hey @bob can you check this?',
    },
  ],
  backup_failed: [
    { name: 'runId', label: 'Backup run ID' },
  ],
};

/**
 * #250: return the variable manifest available to the editor for a
 * given type. Always returns at least the standard ctx variables,
 * even when the type has no per-payload entry yet, so the palette
 * is never empty.
 */
export function getTemplateVariables(
  type: NotificationType,
): TemplateVariableDescriptor[] {
  const typeVars = TYPE_VARIABLES[type] ?? [];
  return [...typeVars, ...STANDARD_VARIABLES];
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

  data_collection_feature_created: ((
    payload: DataCollectionFeatureCreatedPayload,
    ctx,
  ) => {
    const deploymentUrl = `${ctx.baseUrl}/items/${payload.dataCollectionId}`;
    const dataLayerUrl = `${ctx.baseUrl}/items/${payload.dataLayerId}`;
    const subject = `New field submission on "${payload.dataCollectionTitle}": ${payload.summary}`;
    const text =
      `${payload.createdByName} added a feature through your "${payload.dataCollectionTitle}" field deployment.\n\n` +
      `Layer: ${payload.dataLayerTitle}\n` +
      `Summary: ${payload.summary}\n\n` +
      `Deployment: ${deploymentUrl}\n` +
      `Data layer: ${dataLayerUrl}\n`;
    const html =
      `<p><strong>${escapeHtml(payload.createdByName)}</strong> added a feature ` +
      `through your <strong>${escapeHtml(payload.dataCollectionTitle)}</strong> ` +
      `field deployment.</p>` +
      `<ul>` +
      `<li>Layer: ${escapeHtml(payload.dataLayerTitle)}</li>` +
      `<li>Summary: ${escapeHtml(payload.summary)}</li>` +
      `</ul>` +
      `<p><a href="${escapeAttr(deploymentUrl)}">Open the deployment</a> · ` +
      `<a href="${escapeAttr(dataLayerUrl)}">open the data layer</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  form_submission_received: ((
    payload: FormSubmissionReceivedPayload,
    ctx,
  ) => {
    const formUrl = `${ctx.baseUrl}/items/${payload.formItemId}`;
    const submissionUrl =
      `${ctx.baseUrl}/items/${payload.formItemId}/submissions/${payload.submissionId}`;
    const subject = `New submission on "${payload.formTitle}": ${payload.summary}`;
    // Phase 1 receipt body (#190). When the trigger captured a list
    // of `{ label, value }` answers, render them as a plain table so
    // the recipient sees the whole submission inline; otherwise fall
    // back to the one-line summary used pre-#190. Both shapes ship
    // simultaneously so a queued payload from an older worker still
    // renders cleanly.
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const answersText = answers.length
      ? answers.map((a) => `  ${a.label}: ${a.value}`).join('\n')
      : `Summary: ${payload.summary}`;
    const text =
      `${payload.submittedByName} submitted a response to "${payload.formTitle}".\n\n` +
      `${answersText}\n\n` +
      `View submission: ${submissionUrl}\n` +
      `Form: ${formUrl}\n`;
    const answersHtml = answers.length
      ? `<table cellpadding="6" cellspacing="0" border="0" ` +
        `style="border-collapse:collapse;margin:8px 0;font-size:14px;">` +
        answers
          .map(
            (a) =>
              `<tr>` +
              `<td style="border-bottom:1px solid #e5e7eb;color:#374151;` +
              `font-weight:600;vertical-align:top;padding-right:12px;">` +
              `${escapeHtml(a.label)}</td>` +
              `<td style="border-bottom:1px solid #e5e7eb;color:#111827;` +
              `vertical-align:top;white-space:pre-wrap;">` +
              `${escapeHtml(a.value)}</td>` +
              `</tr>`,
          )
          .join('') +
        `</table>`
      : `<ul><li>Summary: ${escapeHtml(payload.summary)}</li></ul>`;
    const html =
      `<p><strong>${escapeHtml(payload.submittedByName)}</strong> submitted a response ` +
      `to <strong>${escapeHtml(payload.formTitle)}</strong>.</p>` +
      answersHtml +
      `<p><a href="${escapeAttr(submissionUrl)}">View submission</a> &middot; ` +
      `<a href="${escapeAttr(formUrl)}">open the form</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  data_collection_schema_break: ((
    payload: DataCollectionSchemaBreakPayload,
    ctx,
  ) => {
    const deploymentUrl = `${ctx.baseUrl}/items/${payload.dataCollectionId}`;
    const dataLayerUrl = `${ctx.baseUrl}/items/${payload.dataLayerId}`;
    const droppedSummary =
      payload.droppedLayerKeys.length > 0
        ? `Dropped: ${payload.droppedLayerKeys.join(', ')}`
        : '';
    const geomSummary =
      payload.geometryChangedLayerKeys.length > 0
        ? `Geometry changed: ${payload.geometryChangedLayerKeys.join(', ')}`
        : '';
    const subject = `Action needed: "${payload.dataCollectionTitle}" offline copies will fail to sync`;
    const text =
      `${payload.changedByName} just changed "${payload.dataLayerTitle}" in a way that breaks ` +
      `field offline copies of your "${payload.dataCollectionTitle}" deployment.\n\n` +
      (droppedSummary ? `${droppedSummary}\n` : '') +
      (geomSummary ? `${geomSummary}\n` : '') +
      `\n` +
      `Field users with offline copies of this deployment will see a "DBMS table not found" or ` +
      `geometry-mismatch error on their next sync. Ask them to rebuild their offline area, or wait ` +
      `until you've revised the deployment yourself before they reconnect.\n\n` +
      `Deployment: ${deploymentUrl}\n` +
      `Data layer: ${dataLayerUrl}\n`;
    const breakBullets =
      `<ul>` +
      (droppedSummary
        ? `<li>${escapeHtml(droppedSummary)}</li>`
        : '') +
      (geomSummary ? `<li>${escapeHtml(geomSummary)}</li>` : '') +
      `</ul>`;
    const html =
      `<p><strong>${escapeHtml(payload.changedByName)}</strong> just changed ` +
      `<strong>${escapeHtml(payload.dataLayerTitle)}</strong> in a way that breaks ` +
      `field offline copies of your <strong>${escapeHtml(payload.dataCollectionTitle)}</strong> ` +
      `deployment.</p>` +
      breakBullets +
      `<p>Field users with offline copies of this deployment will see a "DBMS table not found" ` +
      `or geometry-mismatch error on their next sync. Ask them to rebuild their offline area, or ` +
      `wait until you've revised the deployment yourself before they reconnect.</p>` +
      `<p><a href="${escapeAttr(deploymentUrl)}">Open the deployment</a> &middot; ` +
      `<a href="${escapeAttr(dataLayerUrl)}">open the data layer</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  user_invited: ((payload: UserInvitedPayload, ctx) => {
    const expiryNote = payload.expiresAt
      ? ` (link expires ${formatDate(payload.expiresAt)})`
      : '';
    const subject = `${payload.invitedByName} invited you to ${ctx.orgLabel}`;
    const text =
      `${payload.invitedByName} invited you to ${ctx.orgLabel}.\n\n` +
      `Click the link below to set a password and sign in${expiryNote}:\n\n` +
      `${payload.inviteLink}\n`;
    const html =
      `<p><strong>${escapeHtml(payload.invitedByName)}</strong> invited you to ` +
      `<strong>${escapeHtml(ctx.orgLabel)}</strong>.</p>` +
      `<p>Click the button below to set a password and sign in${escapeHtml(
        expiryNote,
      )}:</p>` +
      `<p><a href="${escapeAttr(payload.inviteLink)}" ` +
      `style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">` +
      `Accept invitation</a></p>` +
      `<p style="font-size:12px;color:#666;">Or copy this link into your browser: ` +
      `<a href="${escapeAttr(payload.inviteLink)}">${escapeHtml(payload.inviteLink)}</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  comment_mentioned: ((payload: CommentMentionedPayload, ctx) => {
    const itemUrl =
      `${ctx.baseUrl}/items/${payload.itemId}` +
      `?comments=1&thread=${encodeURIComponent(payload.threadId)}`;
    const subject = `${payload.mentionedByName} mentioned you on "${payload.itemTitle}"`;
    const text =
      `${payload.mentionedByName} mentioned you in a comment on "${payload.itemTitle}" on ${ctx.orgLabel}.\n\n` +
      `"${payload.snippet}"\n\n` +
      `Open the conversation: ${itemUrl}\n`;
    const html =
      `<p><strong>${escapeHtml(payload.mentionedByName)}</strong> mentioned you in a comment on ` +
      `<strong>${escapeHtml(payload.itemTitle)}</strong> on ${escapeHtml(ctx.orgLabel)}.</p>` +
      `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #cbd5e1;color:#334155;">` +
      `${escapeHtml(payload.snippet)}</blockquote>` +
      `<p><a href="${escapeAttr(itemUrl)}">Open the conversation</a></p>`;
    return { subject, text, html };
  }) as Renderer<unknown>,

  backup_failed: ((payload: { runId?: string }, ctx) => {
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const subject = `A backup did not finish on ${ctx.orgLabel}`;
    const text =
      `A backup did not finish. Open Admin, Backup, and read that run.\n` +
      `Run id: ${runId}\n`;
    const html =
      `<p>A backup did not finish on ${escapeHtml(ctx.orgLabel)}. ` +
      `Open Admin, Backup, and read that run.</p>` +
      `<p>Run id: ${escapeHtml(runId)}</p>`;
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
  // Validate that `type` is a known key before indexing `renderers`.
  // The DB enum guarantees this at runtime today, but CodeQL flags
  // the raw bracket-lookup as js/unvalidated-dynamic-method-call
  // because the type parameter is plumbed in from notification rows
  // that originate from external input. A hasOwnProperty gate makes
  // the safe set explicit and prevents prototype-chain method
  // dispatch (`toString`, `hasOwnProperty`, etc).
  if (!Object.prototype.hasOwnProperty.call(renderers, type)) return null;
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
