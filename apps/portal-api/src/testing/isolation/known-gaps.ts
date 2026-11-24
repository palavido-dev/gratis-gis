// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Routes that do not yet meet their isolation check, per tenancy mode.
// The suite expects each of these to fail. When a fix makes one pass,
// the suite fails until the entry is removed, so this list only
// shrinks. Each entry names the area of work that owns the fix.

import type { TenancyMode } from '../../common/tenancy.js';

export type KnownGap = {
  modes: TenancyMode[];
  /** The area of work that owns the fix. */
  area: string;
  /** One line: what is wrong, in neutral words. */
  note: string;
};

const BOTH: TenancyMode[] = ['single', 'multi'];

/** Another org's id answers 403 where it should answer 404. */
const existence = (what: string): KnownGap => ({
  modes: BOTH,
  area: '404 for other organizations',
  note: `${what} of another org answers 403, which tells the caller the id exists`,
});

export const KNOWN_GAPS: Record<string, KnownGap> = {
  'GET /api/analysis-jobs/:jobId': existence('an analysis job'),
  'POST /api/analysis-jobs/:jobId/cancel': existence('an analysis job'),
  'GET /api/import-jobs/:jobId': existence('an import job'),
  'POST /api/import-jobs/:jobId/cancel': existence('an import job'),
  'GET /api/forms/:id/submissions': existence('a form'),
  'GET /api/forms/:id/submissions/_count': existence('a form'),
  'GET /api/forms/:id/submissions/:submissionId/pdf': existence('a form'),
  'POST /api/forms/:id/submissions': existence('a form'),
  'GET /api/realtime/maps/:mapId/presence': existence('a map'),
  'POST /api/realtime/maps/:mapId/presence/heartbeat': existence('a map'),
  'POST /api/realtime/maps/:mapId/presence/leave': existence('a map'),
  'POST /api/realtime/maps/:mapId/presence/ticket': existence('a map'),
  'DELETE /api/realtime/maps/:mapId/presence/:connectionId': existence('a map'),
  'PATCH /api/items/:mapId/drawings/settings/allow-anonymous': existence('a map'),
  'GET /api/storage/private/:kind/:key': {
    modes: BOTH,
    area: '404 for other organizations',
    note: 'a signed-out caller gets 403 for a private attachment key, which tells it the key exists',
  },
  'PATCH /api/admin/users/:id': existence('a user'),
  'DELETE /api/admin/users/:id': existence('a user'),
  'POST /api/admin/users/:id/reset-password': existence('a user'),
  'POST /api/postgis-live/:serviceItemId/features': {
    modes: BOTH,
    area: '404 for other organizations',
    note: "another org's item of a different type answers 400 naming the type check, before the access check",
  },
  'POST /api/postgis-live/:serviceItemId/probe': {
    modes: BOTH,
    area: '404 for other organizations',
    note: "another org's item of a different type answers 400 naming the type check, before the access check",
  },
};
