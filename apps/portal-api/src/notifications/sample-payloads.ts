// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotificationType } from '@prisma/client';

import type {
  ShareCreatedPayload,
  ShareExpiryPayload,
  UserDisablePayload,
  EditorFeatureCreatedPayload,
  DataCollectionFeatureCreatedPayload,
  DataCollectionSchemaBreakPayload,
  FormSubmissionReceivedPayload,
  CommentMentionedPayload,
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
    sharedByName: 'Admin User',
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
    createdByName: 'Contributor User',
    summary: 'Inspection #4127 (cracked grate)',
  } satisfies EditorFeatureCreatedPayload,
  data_collection_feature_created: {
    dataCollectionId: '00000000-0000-4000-8000-000000000030',
    dataCollectionTitle: 'Yard Inspection',
    dataLayerId: '00000000-0000-4000-8000-000000000040',
    dataLayerTitle: 'Inspection Points',
    layerKey: 'points',
    featureId: 'points/456',
    createdByName: 'Field Worker',
    summary: 'Point near pool fence',
  } satisfies DataCollectionFeatureCreatedPayload,
  form_submission_received: {
    formItemId: '00000000-0000-4000-8000-000000000050',
    formTitle: 'Volunteer Sign-Up',
    submissionId: '00000000-0000-4000-8000-000000000060',
    submittedByName: 'Visitor',
    summary: 'jane@example.com',
    // #190: rendered receipt of every answered question. The admin
    // preview shows the same table the real recipient would see.
    answers: [
      { label: 'Email', value: 'jane@example.com' },
      { label: 'Full name', value: 'Jane Doe' },
      { label: 'Available days', value: 'Saturday, Sunday' },
      { label: 'Notes', value: 'Happy to help with cleanup.' },
    ],
  } satisfies FormSubmissionReceivedPayload,
  data_collection_schema_break: {
    dataCollectionId: '00000000-0000-4000-8000-000000000030',
    dataCollectionTitle: 'Yard Inspection',
    dataLayerId: '00000000-0000-4000-8000-000000000040',
    dataLayerTitle: 'Inspection Points',
    changedByName: 'Admin User',
    droppedLayerKeys: ['burrow_points'],
    geometryChangedLayerKeys: [],
  } satisfies DataCollectionSchemaBreakPayload,
  comment_mentioned: {
    itemId: '00000000-0000-4000-8000-000000000001',
    itemTitle: 'City Park Review',
    threadId: '00000000-0000-4000-8000-0000000000c1',
    commentId: '00000000-0000-4000-8000-0000000000c2',
    mentionedByName: 'Alice Author',
    snippet: 'Hey @bob can you check the north entrance pin?',
  } satisfies CommentMentionedPayload,
  backup_failed: {
    runId: '00000000-0000-4000-8000-0000000000b1',
  },
};
