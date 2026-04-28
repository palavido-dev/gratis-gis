import { NotificationType } from '@prisma/client';

import type {
  ShareCreatedPayload,
  ShareExpiryPayload,
  UserDisablePayload,
  EditorFeatureCreatedPayload,
} from './templates.js';

/**
 * Realistic-looking sample payloads keyed by NotificationType, used
 * by the admin /admin/notifications/preview/:type endpoint so admins
 * can see what each email actually looks like without firing a real
 * trigger (#137).
 *
 * Adding a new NotificationType: extend this map alongside the
 * renderer in templates.ts. The preview endpoint refuses unknown
 * types so a missed entry doesn't crash the page.
 */
export const SAMPLE_PAYLOADS: { [K in NotificationType]?: unknown } = {
  share_created: {
    itemId: '00000000-0000-4000-8000-000000000001',
    itemTitle: 'City Park Trees',
    itemType: 'data-layer',
    permission: 'view',
    sharedByName: 'Bob Example',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  } satisfies ShareCreatedPayload,
  share_expiring: {
    itemId: '00000000-0000-4000-8000-000000000001',
    itemTitle: 'City Park Trees',
    itemType: 'data-layer',
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    principalType: 'user',
    principalId: '00000000-0000-4000-8000-0000000000aa',
  } satisfies ShareExpiryPayload,
  share_expired: {
    itemId: '00000000-0000-4000-8000-000000000001',
    itemTitle: 'City Park Trees',
    itemType: 'data-layer',
    expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    principalType: 'user',
    principalId: '00000000-0000-4000-8000-0000000000aa',
  } satisfies ShareExpiryPayload,
  user_auto_disable_warning: {
    autoDisableAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
  } satisfies UserDisablePayload,
  user_disabled: {
    autoDisableAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  } satisfies UserDisablePayload,
  editor_feature_created: {
    editorId: '00000000-0000-4000-8000-000000000010',
    editorTitle: 'Storm Drain Inspection',
    dataLayerId: '00000000-0000-4000-8000-000000000020',
    dataLayerTitle: 'Storm Drains',
    layerKey: 'drains',
    featureId: 'drains/123',
    createdByName: 'Alice Example',
    summary: 'Inspection #4127 (cracked grate)',
  } satisfies EditorFeatureCreatedPayload,
};
