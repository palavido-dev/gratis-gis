import { NotificationChannel, NotificationType } from '@prisma/client';

/**
 * Catalog of notification types the user can opt in / out of, with
 * human-readable labels + descriptions and a category for grouping
 * the preferences UI. The catalog is server-driven (rather than
 * hard-coded in the web app) so adding a new NotificationType is a
 * one-place edit: append an entry here, the settings page picks it
 * up automatically.
 *
 * Defaults live alongside the catalog. `defaultEnabled` records
 * whether the type fires for a user with no `notification_preference`
 * row stored. The matching default in NotificationsService.notify()
 * reads this same value so the UI and the worker agree on the
 * "what fires when no row exists" answer.
 *
 * Categories are intentionally a small fixed set:
 *   - sharing: events about items shared with the user
 *   - account: events about the user's own account lifecycle
 *   - editor:  events about features collected via editor items
 *
 * Channels are also fixed today (email only). The shape is per-type
 * + per-channel because Phase 3 will add webhooks / in-app and a
 * user might want share_created over email but not over webhook.
 */
export type NotificationCategory = 'sharing' | 'account' | 'editor';

export interface NotificationTypeMeta {
  type: NotificationType;
  category: NotificationCategory;
  label: string;
  description: string;
  /** Channels this type can deliver through. Driven by which
   *  templates.ts has a renderer for AND which channels the platform
   *  supports today. Phase 1 / 2a: email only. */
  channels: NotificationChannel[];
  /** Default enabled state per channel when no preference row exists.
   *  Currently every type defaults to enabled across every channel;
   *  we keep the per-channel shape so a future "default off" type
   *  (e.g. very chatty editor activity) can land without a schema
   *  migration. */
  defaultByChannel: Record<NotificationChannel, boolean>;
}

const ALL_CHANNELS: NotificationChannel[] = ['email'];
const ALL_DEFAULT_ON: Record<NotificationChannel, boolean> = { email: true };

/**
 * Authoritative list, ordered the way the settings UI should render
 * them top-to-bottom. Same order also applies to the rendering of
 * the cron sweep -- not load-bearing, just pleasant.
 */
export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  // Sharing
  {
    type: 'share_created',
    category: 'sharing',
    label: 'Item shared with you',
    description:
      'Someone shares an item directly or via a group you belong to.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },
  {
    type: 'share_expiring',
    category: 'sharing',
    label: 'Share about to expire',
    description: 'Your access to a shared item is within the warning window.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },
  {
    type: 'share_expired',
    category: 'sharing',
    label: 'Share has expired',
    description: 'Your access to a shared item has lapsed.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },

  // Account
  {
    type: 'user_auto_disable_warning',
    category: 'account',
    label: 'Account disable warning',
    description:
      'Your account is scheduled to be disabled for inactivity within the warning window.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },
  {
    type: 'user_disabled',
    category: 'account',
    label: 'Account disabled',
    description: 'Your account was disabled.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },

  // Editor
  {
    type: 'editor_feature_created',
    category: 'editor',
    label: 'New submission on your editor',
    description:
      'Someone created a feature through an editor you own. Useful for "send me an email per response" data-collection workflows.',
    channels: ALL_CHANNELS,
    defaultByChannel: ALL_DEFAULT_ON,
  },
];

/** Lookup by NotificationType. */
export function getTypeMeta(
  type: NotificationType,
): NotificationTypeMeta | undefined {
  return NOTIFICATION_TYPES.find((t) => t.type === type);
}
