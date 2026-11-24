// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every HTTP route of the API, classified for the two-organization
// isolation suites. routes-coverage.spec.ts fails when a route exists
// that is not listed here (or a listed route no longer exists), so a
// new controller route cannot ship without a decision about who may
// reach it. docs/testing/org-isolation.md explains how to add one.
//
// Classes:
// - org-private: data of one organization. Called by org B's admin
//   with org A's ids it must answer 404 (or an empty list) and change
//   nothing of org A's.
// - public-by-design: open to anyone, but only for `public` items.
//   A private or org-only item of another org must read as 404.
// - operator-only: install-wide powers (OperatorOrgGuard). The admin
//   of an org that is not the operator gets 403.
// - no-tenant-data: health, versions, static lists. Must not carry
//   another org's data.
//
// Checks (how the suite probes a route):
// - read:   B's admin with A's ids gets 404; A's admin (the control)
//           gets a 2xx, so the 404 is not a broken request.
// - write:  B's admin with A's ids gets 404 and nothing org A owns
//           changes. No control call: it would change A's data.
// - list:   B's admin gets a 2xx whose body holds none of A's ids,
//           names or marker text.
// - own:    a write that only acts on the caller's own org (no foreign
//           id in the input). B's call must leave A unchanged and its
//           answer must hold none of A's data.
// - public: anonymous and B's admin with A's private ids get 404; the
//           same route with A's public ids answers 2xx.
// - public-list: an org-scoped public listing (?org=<slug>). See the
//           suite for the cases.
// - operator: B's and A's admins get 403 in multi mode; the operator
//           org's admin passes the guard; with GRATIS_OPERATOR_ORG_ID
//           unset nobody passes.
// - legacy: per-item feature tables, which do not exist in multi mode:
//           404 for every caller there.
// - none:   B's admin gets an answer that holds none of A's data.
// - skip:   classified but not probed over HTTP (reason given).

import type { OrgFixture } from './seed.js';

export type RouteClass = 'org-private' | 'public-by-design' | 'operator-only' | 'no-tenant-data';
export type CheckKind =
  | 'read'
  | 'write'
  | 'list'
  | 'own'
  | 'public'
  | 'public-list'
  | 'operator'
  | 'legacy'
  | 'none'
  | 'skip';

/**
 * A reference to a fixture value, resolved against the org being
 * probed (the victim, A) unless prefixed with `own:` (the caller, B).
 * `=text` is a literal. See resolveRef in suite.ts for the names.
 */
export type Ref = string;

export type BodyBuilder = (victim: OrgFixture, caller: OrgFixture) => unknown;

export type RouteEntry = {
  cls: RouteClass;
  check: CheckKind;
  params?: Record<string, Ref>;
  query?: Record<string, Ref>;
  body?: BodyBuilder;
  /** Statuses B's probe may get. Defaults per check. */
  expect?: number[];
  /** Statuses the same-org control may get, or 'skip' (with reason). */
  control?: number[] | 'skip';
  reason?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Overrides that apply in single mode only (where the rules differ by design). */
  single?: Partial<Omit<RouteEntry, 'single'>>;
};

type Opts = Omit<RouteEntry, 'cls' | 'check'>;

const priv =
  (check: CheckKind) =>
  (o: Opts = {}): RouteEntry => ({ cls: 'org-private', check, ...o });
const read = priv('read');
const write = priv('write');
const list = priv('list');
const own = priv('own');
const legacy = (o: Opts = {}): RouteEntry => ({ cls: 'org-private', check: 'legacy', ...o });
const pub = (o: Opts = {}): RouteEntry => ({ cls: 'public-by-design', check: 'public', ...o });
const pubList = (o: Opts = {}): RouteEntry => ({
  cls: 'public-by-design',
  check: 'public-list',
  ...o,
});
const pubNone = (o: Opts = {}): RouteEntry => ({ cls: 'public-by-design', check: 'none', ...o });
const op = (o: Opts = {}): RouteEntry => ({ cls: 'operator-only', check: 'operator', ...o });
const none = (o: Opts = {}): RouteEntry => ({ cls: 'no-tenant-data', check: 'none', ...o });
const skip = (cls: RouteClass, reason: string): RouteEntry => ({ cls, check: 'skip', reason });

const NO_CONTROL = (reason: string): Opts => ({ control: 'skip', reason });
const OK = [200, 201, 204];

/** Body helpers. */
const ids = (v: OrgFixture) => ({
  layer: v.items['data_layer:private']!,
  map: v.items['map:private']!,
});

export const ROUTES: Record<string, RouteEntry> = {
  // ---------------------------------------------------------------- health, info
  'GET /health': none(),
  'GET /api/portal-info': pubNone({
    reason: 'cases for signed-in A, B and signed-out callers are in the suite',
  }),
  'GET /api/ai/status': list(),
  'GET /api/point-cloud/merge-limits': none(),
  'GET /api/tile-layer/mosaic-limits': none(),
  'GET /api/public/osm/presets': none(),
  'GET /api/admin/updates': none(),
  'GET /api/admin/users/_meta': none(),

  // ---------------------------------------------------------------- operator only
  'DELETE /api/admin/backup/runs/:id': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'GET /api/admin/backup/availability': op(),
  'GET /api/admin/backup/config': op(),
  'GET /api/admin/backup/health': op(),
  'GET /api/admin/backup/restore/status': op(),
  'GET /api/admin/backup/runs': op(),
  'GET /api/admin/backup/runs/:id/download': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'GET /api/admin/backup/runs/:id/restore/preview': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'PATCH /api/admin/backup/config': op(),
  'POST /api/admin/backup/runs': op(),
  'POST /api/admin/backup/runs/:id/cancel': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'POST /api/admin/backup/runs/:id/restore': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'GET /api/admin/backup/offsite': op(),
  'PATCH /api/admin/backup/offsite': op(),
  'POST /api/admin/backup/offsite/test': op(),
  'POST /api/admin/backup/offsite/check-key': op(),
  'POST /api/admin/backup/offsite/take-over': op(),
  'POST /api/admin/backup/offsite/signing-key': op(),
  'POST /api/admin/backup/offsite/check-verify-key': op(),
  'POST /api/admin/backup/runs/:id/offsite': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'GET /api/admin/backup/restore-tests/preflight': op(),
  'GET /api/admin/backup/restore-tests': op(),
  'POST /api/admin/backup/restore-tests': op(),
  'DELETE /api/admin/feedback/:id': op({ params: { id: '=00000000-0000-4000-8000-000000000001' } }),
  'GET /api/admin/feedback': op(),
  'GET /api/admin/feedback/:id/screenshot': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'PATCH /api/admin/feedback/:id': op({ params: { id: '=00000000-0000-4000-8000-000000000001' } }),
  'DELETE /api/admin/import-ago/connections/:id': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'PATCH /api/admin/import-ago/connections/:id': op({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'POST /api/admin/import-ago/connections': op(),
  'DELETE /api/admin/security/oidc/:alias': op({ params: { alias: '=none' } }),
  'GET /api/admin/security': op(),
  'POST /api/admin/security/oidc': op(),
  'PUT /api/admin/security/mfa': op(),
  'GET /api/admin/housekeeping/largest-data-layers': op(),
  'GET /api/admin/housekeeping/largest-tables': op(),
  'GET /api/admin/housekeeping/orphaned-uploads': op(),
  'GET /api/admin/housekeeping/runs': op(),
  'GET /api/admin/housekeeping/storage': op(),
  'PATCH /api/admin/housekeeping/config': op(),
  'POST /api/admin/housekeeping/orphaned-uploads/purge': op(),
  'POST /api/admin/housekeeping/run': op(),
  'GET /api/admin/maintenance': op(),
  'POST /api/admin/maintenance': op(),
  'GET /api/admin/notifications/recent': op(),
  'GET /api/admin/notifications/smtp': op(),
  'GET /api/admin/notifications/stats': op(),
  'POST /api/admin/notifications/:id/retry': op({ params: { id: 'notification' } }),
  'POST /api/admin/notifications/smtp/test': op(),
  'PUT /api/admin/notifications/defaults': op(),
  'PUT /api/admin/notifications/smtp': op(),
  'GET /api/admin/readiness': op(),
  // Under OperatorOrgGuard but marked org scoped in multi mode: each org
  // keeps its own list, so in multi mode these are the caller's own.
  'GET /api/admin/security/embed-origins': list({
    single: { cls: 'operator-only', check: 'operator' },
    reason: "install-wide in single mode, each org's own in multi mode",
  }),
  'PUT /api/admin/security/embed-origins': own({
    body: () => ({ origins: ['https://b.example.test'] }),
    single: { cls: 'operator-only', check: 'operator' },
    reason: "install-wide in single mode, each org's own in multi mode",
  }),

  // ---------------------------------------------------------------- admin, the caller's own org
  'DELETE /api/admin/ai': own(),
  'GET /api/admin/ai': list(),
  'PUT /api/admin/ai': own({
    body: () => ({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-test-b' }),
  }),
  'GET /api/admin/app-templates/starter-status': list(),
  'POST /api/admin/app-templates/restore-starters': own(),
  'GET /api/admin/themes/starter-status': list(),
  'POST /api/admin/themes/restore-starters': own(),
  'GET /api/admin/audit': list(),
  'GET /api/admin/basemap/probe': skip('no-tenant-data', 'fetches an outside URL; no tenant input'),
  'GET /api/admin/branding': list(),
  'PATCH /api/admin/branding': own({ body: () => ({ landingTitle: 'B landing' }) }),
  'GET /api/admin/integrations': list(),
  'PATCH /api/admin/integrations': own({ body: () => ({}) }),
  'GET /api/admin/onboarding': list(),
  'POST /api/admin/onboarding/:key/complete': own({ params: { key: '=admin-docs' } }),
  'POST /api/admin/onboarding/:key/dismiss': own({ params: { key: '=configure-email' } }),
  'POST /api/admin/onboarding/:key/restore': own({ params: { key: '=configure-email' } }),
  'GET /api/admin/permissions': list(),
  'GET /api/admin/permissions/export.csv': list(),
  'POST /api/admin/diagnostics/bundle': own(),
  'GET /api/admin/field-queues': list(),
  'DELETE /api/admin/field-queues/:id': write({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
  }),
  'POST /api/admin/field-queues/forget-stale': own(),
  'GET /api/admin/housekeeping/config': list(),
  'GET /api/admin/housekeeping/dangling-references': list(),
  'GET /api/admin/housekeeping/expiring-shares': list(),
  'GET /api/admin/housekeeping/expiring-users': list(),
  'GET /api/admin/housekeeping/large-items': list(),
  'GET /api/admin/housekeeping/search-index-build': list(),
  'GET /api/admin/housekeeping/stale-items': list(),
  'GET /api/admin/housekeeping/stale-users': list(),
  'GET /api/admin/housekeeping/summary': list(),
  'POST /api/admin/housekeeping/build-search-indexes': own(),
  'POST /api/admin/housekeeping/recompute-extents': own(),
  'GET /api/admin/import-ago/connections': list(),
  'GET /api/admin/import-ago/connections/:id': read({
    params: { id: '=00000000-0000-4000-8000-000000000001' },
    control: 'skip',
    reason: 'no connection seeded',
  }),
  'GET /api/admin/import-ago/run/:id': read({ params: { id: 'job:agoImport' } }),
  'POST /api/admin/import-ago/oauth/start': skip(
    'org-private',
    'starts an outside OAuth flow; needs a connection',
  ),
  'POST /api/admin/import-ago/preview': skip('org-private', 'calls an outside portal'),
  'POST /api/admin/import-ago/run': skip('org-private', 'calls an outside portal'),
  'POST /api/admin/import-ago/run/start': skip('org-private', 'calls an outside portal'),
  'POST /api/admin/import-ago/run/:id/cancel': write({ params: { id: 'job:agoImport' } }),
  'GET /api/admin/jobs': list(),
  'POST /api/admin/jobs/:id/cancel': write({
    params: { id: 'job:import' },
    body: () => ({ kind: 'import' }),
  }),
  'POST /api/admin/jobs/:id/retry': write({
    params: { id: 'job:import' },
    body: () => ({ kind: 'import' }),
  }),
  'GET /api/admin/notifications/defaults': list(),
  'GET /api/admin/notifications/preview/:type': list({ params: { type: '=share_created' } }),
  'GET /api/admin/notifications/templates': list(),
  'GET /api/admin/notifications/templates/:type/:channel': list({
    params: { type: '=share_created', channel: '=email' },
  }),
  'DELETE /api/admin/notifications/templates/:type/:channel': own({
    params: { type: '=share_created', channel: '=email' },
  }),
  'PUT /api/admin/notifications/templates/:type/:channel': own({
    params: { type: '=share_created', channel: '=email' },
    body: () => ({ subject: 'B subject', bodyText: 'B body', bodyHtml: '<p>B body</p>' }),
  }),
  'POST /api/admin/notifications/templates/preview': own({
    body: () => ({ type: 'share_created', subject: 's', bodyText: 't', bodyHtml: '<p>t</p>' }),
  }),
  'GET /api/admin/users': list(),
  'GET /api/admin/users/:id': read({ params: { id: 'user:viewer' } }),
  'GET /api/admin/users/:id/access': read({ params: { id: 'user:viewer' } }),
  'GET /api/admin/users/:id/capabilities': read({ params: { id: 'user:viewer' } }),
  'DELETE /api/admin/users/:id': write({ params: { id: 'user:viewer' } }),
  'DELETE /api/admin/users/:id/capabilities/:capability': write({
    params: { id: 'user:viewer', capability: '=can_publish_items' },
  }),
  'PATCH /api/admin/users/:id': write({
    params: { id: 'user:viewer' },
    body: () => ({ orgRole: 'contributor' }),
  }),
  'POST /api/admin/users': own({
    body: () => ({
      username: 'iso-b-invited',
      email: 'iso-b-invited@example.test',
      sendSetupEmail: false,
    }),
  }),
  'POST /api/admin/users/:id/capabilities': write({
    params: { id: 'user:viewer' },
    body: () => ({ capability: 'can_publish_items', enabled: true }),
  }),
  'POST /api/admin/users/:id/reset-password': write({ params: { id: 'user:viewer' } }),

  // ---------------------------------------------------------------- AI
  'POST /api/ai/build': skip('org-private', 'needs a configured AI provider (outside call)'),
  'POST /api/ai/draft': write({
    body: (v) => ({ itemId: ids(v).layer, instruction: 'describe' }),
    expect: [404, 503],
    reason: 'no AI provider here, so 503 is the answer before the item lookup',
  }),
  'POST /api/ai/features': write({
    body: (v) => ({ itemId: ids(v).layer, layerId: 'sites', question: 'how many' }),
    expect: [404, 503],
    reason: 'no AI provider here, so 503 is the answer before the item lookup',
  }),

  // ---------------------------------------------------------------- analysis
  'GET /api/analysis-jobs/:jobId': read({ params: { jobId: 'job:analysis' } }),
  'POST /api/analysis-jobs/:jobId/cancel': write({ params: { jobId: 'job:analysis' } }),
  'GET /api/items/:itemId/analysis/jobs': read(),
  'POST /api/items/:itemId/analysis/colorize': write({
    expect: [404, 503],
    reason: 'analysis worker is off here',
  }),
  'POST /api/items/:itemId/analysis/contours': write({
    expect: [404, 503],
    reason: 'analysis worker is off here',
  }),
  'POST /api/items/:itemId/analysis/steepness': write({
    expect: [404, 503],
    reason: 'analysis worker is off here',
  }),
  'POST /api/items/:itemId/analysis/elevation': write({
    body: () => ({ resolution: 1 }),
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/analysis/heightmap': write({
    body: () => ({ resolution: 1 }),
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/analysis/hillshade': write({
    body: () => ({ mode: 'dtm', resolution: 1 }),
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/analysis/viewshed': write({
    body: () => ({ lng: -117, lat: 34 }),
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/analysis/zonal-stats': write({
    body: (_v, c) => ({ zoneItemId: c.items['data_layer:private'] }),
    expect: [404, 503],
  }),
  'GET /api/elevation-mosaic/:z/:x/:y.png': pub({
    query: { stack: 'tile_layer:private' },
    expect: [204, 404],
    control: 'skip',
    reason:
      'ids the caller cannot read are dropped from the stack, so the answer is the same empty tile as for an unknown id; a control needs a built elevation tile set',
  }),
  'GET /api/items/:itemId/sam/embedding/:z/:gx/:gy': read({
    ...NO_CONTROL('needs imagery and the analysis worker'),
  }),
  'GET /api/items/:itemId/sam/embedding/:z/:gx/:gy/state': read({
    ...NO_CONTROL('needs imagery and the analysis worker'),
  }),
  'POST /api/items/:itemId/sam/embedding': write({
    expect: [404, 503],
    reason: 'analysis worker is off here',
  }),

  // ---------------------------------------------------------------- forms
  'GET /api/forms/:id/submissions': read({ params: { id: 'form:private' } }),
  'GET /api/forms/:id/submissions/_count': read({ params: { id: 'form:private' } }),
  'GET /api/forms/:id/submissions/:submissionId/pdf': read({
    params: { id: 'form:private', submissionId: '=00000000-0000-4000-8000-000000000001' },
    ...NO_CONTROL('no submission seeded'),
  }),
  'POST /api/forms/:id/submissions': write({
    params: { id: 'form:private' },
    body: () => ({
      clientId: 'client-0001',
      schemaVersion: 1,
      response: {},
      capturedAt: '2026-01-01T00:00:00Z',
    }),
  }),

  // ---------------------------------------------------------------- geocoding
  'GET /api/geocode/:itemId': read({
    params: { itemId: 'geocoding_service:private' },
    query: { text: '=main' },
    control: [200, 400],
    reason: 'the seeded geocoder has no search configuration, so A gets 400 after the access check',
  }),
  'POST /api/geocode/:itemId/rebuild-indexes': write({
    params: { itemId: 'geocoding_service:private' },
  }),
  'POST /api/geocode/probe-arcgis': skip('no-tenant-data', 'probes an outside URL'),

  // ---------------------------------------------------------------- groups
  'GET /api/groups': list(),
  'GET /api/groups/trash': list(),
  'GET /api/groups/:id': read({ params: { id: 'group' } }),
  'GET /api/groups/:id/members': read({ params: { id: 'group' } }),
  'POST /api/groups': own({ body: () => ({ title: 'B new group' }) }),
  'PATCH /api/groups/:id': write({ params: { id: 'group' }, body: () => ({ title: 'renamed' }) }),
  'POST /api/groups/:id/members': write({
    params: { id: 'group' },
    body: (_v, c) => ({ userId: c.users.viewer.id }),
  }),
  'DELETE /api/groups/:id/members/:userId': write({
    params: { id: 'group', userId: 'user:contributor' },
  }),
  'POST /api/groups/:id/restore': write({ params: { id: 'group' } }),
  'DELETE /api/groups/:id': write({ params: { id: 'group' } }),
  'DELETE /api/groups/:id/purge': write({ params: { id: 'group' } }),

  // ---------------------------------------------------------------- import jobs, ingest
  'GET /api/import-jobs/:jobId': read({ params: { jobId: 'job:import' } }),
  'POST /api/import-jobs/:jobId/cancel': write({ params: { jobId: 'job:import' } }),
  'GET /api/items/:id/import-jobs/active': read(),
  'POST /api/items/:id/layers/:layerId/import-jobs': write({
    body: () => ({ stagingId: '00000000-0000-4000-8000-000000000001', sourceLayerName: 'sites' }),
  }),
  'POST /api/items/:id/layers/:layerId/import': write({
    query: { stagingId: '=00000000-0000-4000-8000-000000000001' },
  }),
  'POST /api/ingest/probe': skip('org-private', 'multipart upload of a file; no foreign id'),
  'POST /api/ingest/stage': skip('org-private', 'multipart upload of a file; no foreign id'),
  'POST /api/ingest/to-geojson': skip('org-private', 'multipart upload of a file; no foreign id'),
  'POST /api/ingest/upload/start': own({
    body: () => ({ fileName: 'x.geojson', size: 10 }),
    expect: [200, 201, 400, 503],
  }),
  'POST /api/ingest/upload/abort': own({
    body: () => ({ handle: 'not-a-handle' }),
    expect: [400, 403, 404],
  }),
  'POST /api/ingest/upload/complete': own({
    body: () => ({ handle: 'not-a-handle', parts: [] }),
    expect: [400, 403, 404],
  }),
  'POST /api/ingest/upload/sign': own({
    body: () => ({ handle: 'not-a-handle', partNumbers: [1] }),
    expect: [400, 403, 404],
  }),
  'POST /api/ingest/upload/status': own({
    body: () => ({ handle: 'not-a-handle' }),
    expect: [400, 403, 404],
  }),

  // ---------------------------------------------------------------- items
  'GET /api/items': list(),
  'GET /api/items/trash': list(),
  'GET /api/items/permissions': list({ query: { ids: 'data_layer:private' } }),
  'GET /api/items/principal-access': list({
    query: { principalType: '=user', principalId: 'user:contributor' },
  }),
  'GET /api/items/:id': read(),
  'GET /api/items/:id/cascade-revert-candidates': read(),
  'GET /api/items/:id/delete-cascade': read(),
  'GET /api/items/:id/dependencies': read(),
  'GET /api/items/:id/dependents': read(),
  'GET /api/items/:id/folder-contents': read({ params: { id: 'folder:private' } }),
  'GET /api/items/:id/geojson': read(),
  'GET /api/items/:id/permissions': read(),
  'GET /api/items/:id/snapshots': read(),
  'GET /api/items/:id/thumbnail.svg': pub(),
  'GET /api/items/:id/web-map.json': read({ params: { id: 'map:private' } }),
  'GET /api/items/:id/proxy': read({
    params: { id: 'service:private' },
    ...NO_CONTROL('the service has no upstream URL here'),
  }),
  'GET /api/items/:id/proxy/*': read({
    params: { id: 'service:private' },
    ...NO_CONTROL('the service has no upstream URL here'),
  }),
  'GET /api/items/:id/credential': read(),
  'PUT /api/items/:id/credential': write({
    params: { id: 'service:private' },
    body: () => ({ kind: 'bearer', token: 'x' }),
  }),
  'DELETE /api/items/:id/credential': write({ params: { id: 'service:private' } }),
  'POST /api/items': own({
    body: () => ({ type: 'file', title: 'B created', data: {}, access: 'private' }),
  }),
  'POST /api/items/:id/copy': write({ body: () => ({ title: 'copied' }), expect: [404] }),
  'PATCH /api/items/:id': write({ body: () => ({ title: 'renamed' }) }),
  'PATCH /api/items/:id/owner': write({ body: (_v, c) => ({ newOwnerId: c.users.admin.id }) }),
  'POST /api/items/:id/share': write({
    body: (_v, c) => ({ principalType: 'user', principalId: c.users.admin.id, permission: 'edit' }),
  }),
  'DELETE /api/items/:id/share': write({
    body: (v) => ({ principalType: 'group', principalId: v.groupId }),
  }),
  'POST /api/items/:id/snapshots/:snapshotId/revert': write(),
  'POST /api/items/:id/restore': write(),
  'DELETE /api/items/:id': write(),
  'DELETE /api/items/:id/purge': write(),
  'POST /api/items/bulk/reassign-owner': own({
    body: (v, c) => ({ itemIds: [ids(v).layer], newOwnerId: c.users.admin.id }),
    expect: [200, 201, 400, 403, 404],
  }),
  'POST /api/items/derived-layer:preview': own({
    body: (v) => ({ source: { itemId: ids(v).layer, layerId: 'sites' }, pipeline: [] }),
    expect: [400, 403, 404],
  }),
  'POST /api/items/web-map-json:import': own({
    body: () => ({ webMap: { version: '2.31', operationalLayers: [] }, title: 'B import' }),
    expect: [200, 201, 400],
    reason: 'a web map with no layers is refused with 400; the check is that nothing of A changes',
  }),
  'POST /api/items/sample-data': skip(
    'org-private',
    'loads large sample content into the caller org; no foreign input',
  ),
  'POST /api/items/showcase-data': skip(
    'org-private',
    'loads large sample content into the caller org; no foreign input',
  ),
  'POST /api/items/:id/copy-to-data-layer': write({ params: { id: 'service:private' } }),
  'POST /api/items/:id/report': write({
    params: { id: 'report_template:private' },
    body: (v) => ({ featureIds: [v.featureIds[0]] }),
  }),
  'POST /api/reports/preview': own({
    body: (v) => ({ sourceItemId: ids(v).layer, layerKey: 'sites', template: {} }),
    expect: [400, 404],
  }),

  // comments
  'GET /api/items/:itemId/comments': pub(),
  'POST /api/items/:itemId/comments': write({
    body: () => ({ body: 'hello', parentKind: 'layer', parentId: 'sites' }),
  }),
  'POST /api/items/:itemId/comments/:threadId/replies': write({ body: () => ({ body: 'hello' }) }),
  'PATCH /api/items/:itemId/comments/:threadId': write({ body: () => ({ resolved: true }) }),
  'PATCH /api/items/:itemId/comments/:threadId/replies/:commentId': write({
    body: () => ({ body: 'edited' }),
  }),
  'DELETE /api/items/:itemId/comments/:threadId/replies/:commentId': write(),

  // drawings
  'GET /api/items/:mapId/drawings': pub(),
  'POST /api/items/:mapId/drawings': write({ body: () => ({ title: 'B drawing' }) }),
  'PATCH /api/items/:mapId/drawings/:drawingId': write({ body: () => ({ title: 'renamed' }) }),
  'DELETE /api/items/:mapId/drawings/:drawingId': write(),
  'PATCH /api/items/:mapId/drawings/settings/allow-anonymous': write({
    body: () => ({ allowed: true }),
  }),
  'POST /api/items/:mapId/drawings/:drawingId/promote': write({
    body: () => ({ title: 'promoted' }),
  }),

  // offline, point cloud, tile layer
  'GET /api/items/:itemId/offline-areas': read({ params: { itemId: 'map:private' } }),
  'POST /api/items/:itemId/offline-areas/:areaId/build': write({
    params: { itemId: 'map:private' },
  }),
  'GET /api/items/:itemId/offline-packages/:packageId/file': read({
    params: { itemId: 'map:private' },
    ...NO_CONTROL('the package file is not in storage here'),
  }),
  'GET /api/point-cloud/:itemId/file': pub({
    params: { itemId: 'point_cloud:private' },
    ...NO_CONTROL('no point cloud file seeded'),
  }),
  'GET /api/point-cloud/:itemId/file.copc.laz': pub({
    params: { itemId: 'point_cloud:private' },
    ...NO_CONTROL('no point cloud file seeded'),
  }),
  'POST /api/items/:itemId/point-cloud/add-sources': write({
    params: { itemId: 'point_cloud:private' },
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/point-cloud/build': write({
    params: { itemId: 'point_cloud:private' },
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/point-cloud/finalize': write({
    params: { itemId: 'point_cloud:private' },
  }),
  'GET /api/tile-layer/:itemId/file': pub({
    params: { itemId: 'tile_layer:private' },
    ...NO_CONTROL('no tile file seeded'),
  }),
  'GET /api/tile-layer/:itemId/file.cog': pub({
    params: { itemId: 'tile_layer:private' },
    ...NO_CONTROL('no tile file seeded'),
  }),
  'GET /api/tile-layer/:itemId/file.pmtiles': pub({
    params: { itemId: 'tile_layer:private' },
    ...NO_CONTROL('no tile file seeded'),
  }),
  'GET /api/tile-layer/:itemId/tiles/:z/:x/:y': pub({
    params: { itemId: 'tile_layer:private' },
    ...NO_CONTROL('no tile file seeded'),
  }),
  'GET /api/tile-layer/:itemId/tiles/:z/:x/:y.png': pub({
    params: { itemId: 'tile_layer:private' },
    ...NO_CONTROL('no tile file seeded'),
  }),
  'POST /api/items/:itemId/tile-layer/finalize': write({
    params: { itemId: 'tile_layer:private' },
  }),
  'POST /api/items/:itemId/tile-layer/mosaic-add-sources': write({
    params: { itemId: 'tile_layer:private' },
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/tile-layer/mosaic-build': write({
    params: { itemId: 'tile_layer:private' },
    expect: [404, 503],
  }),
  'POST /api/items/:itemId/tile-layer/retry-pyramid': write({
    params: { itemId: 'tile_layer:private' },
  }),
  'POST /api/tile-layer/check-space': own({
    body: () => ({ sizeBytes: 10, fileName: 'b.pmtiles' }),
  }),

  // ---------------------------------------------------------------- v3 layers and features
  'GET /api/items/:id/layers/:layerId/aggregate': read({ query: { agg: '=count' } }),
  'GET /api/items/:id/layers/:layerId/attachments': read({
    ...NO_CONTROL('lists every attachment of a layer; covered by the per-feature list'),
  }),
  'GET /api/items/:id/layers/:layerId/csv': read(),
  'GET /api/items/:id/layers/:layerId/delta': read(),
  'GET /api/items/:id/layers/:layerId/expressions/sources': read(),
  'GET /api/items/:id/layers/:layerId/features': read(),
  'GET /api/items/:id/layers/:layerId/features-page': read(),
  'GET /api/items/:id/layers/:layerId/features-search': read({ query: { q: '=open' } }),
  'GET /api/items/:id/layers/:layerId/features/:fid/attachments': read(),
  'GET /api/items/:id/layers/:layerId/features/:fid/attachments/:attId/download': read({
    ...NO_CONTROL('the attachment bytes are not in storage here'),
  }),
  'GET /api/items/:id/layers/:layerId/filtered-extent': read(),
  'GET /api/items/:id/layers/:layerId/geojson': read(),
  'GET /api/items/:id/layers/:layerId/geoparquet': read(),
  'GET /api/items/:id/layers/:layerId/selection-extent': read({ query: { ids: 'feature' } }),
  'GET /api/items/:id/layers/:layerId/tile/:z/:x/:y.mvt': read(),
  'GET /api/items/:id/layers/:layerId/tilejson.json': read(),
  'POST /api/items/:id/layers/:layerId/features': write({
    body: () => ({
      features: [{ geometry: { type: 'Point', coordinates: [0, 0] }, properties: { status: 'b' } }],
    }),
  }),
  'PATCH /api/items/:id/layers/:layerId/features/:fid': write({
    body: () => ({ properties: { status: 'b' } }),
  }),
  'DELETE /api/items/:id/layers/:layerId/features/:fid': write(),
  'POST /api/items/:id/layers/:layerId/features/calculate-field': write({
    body: () => ({ expression: "'b'", outputName: 'status', outputType: 'string', scope: 'all' }),
  }),
  'POST /api/items/:id/layers/:layerId/features/:fid/attachments': write({
    body: (v) => ({
      fileName: 'b.txt',
      mime: 'text/plain',
      sizeBytes: 1,
      storageKey: `feature-attachment/${ids(v).layer}/b.txt`,
      storageUrl: '/x',
    }),
  }),
  'DELETE /api/items/:id/layers/:layerId/features/:fid/attachments/:attId': write(),
  'DELETE /api/items/:id/layers/:layerId/sync-conflicts/:conflictId': write({
    params: { conflictId: '=00000000-0000-4000-8000-000000000001' },
  }),
  'POST /api/items/:id/layers/:layerId/expressions/evaluate': write({
    body: () => ({ expressions: { a: '1' } }),
  }),

  // ---------------------------------------------------------------- legacy per-item feature tables
  'GET /api/items/:id/features': legacy(),
  'GET /api/items/:id/features/:fid': legacy(),
  'GET /api/items/:id/features/:fid/history': legacy(),
  'GET /api/items/:id/features/:fid/related/:childItemId': legacy({
    params: { childItemId: 'data_layer:org' },
  }),
  'POST /api/items/:id/features': legacy({ body: () => ({ features: [] }) }),
  'POST /api/items/:id/features/:fid/related/:childItemId': legacy({
    params: { childItemId: 'data_layer:org' },
    body: () => ({}),
  }),
  'POST /api/items/:id/features/import': legacy({ body: () => ({ features: [] }) }),
  'PATCH /api/items/:id/features/:fid': legacy({ body: () => ({}) }),
  'DELETE /api/items/:id/features/:fid': legacy(),
  'POST /api/items/:id/ingest': legacy({
    single: { expect: [400, 404] },
    reason:
      'in single mode the upload check (no file) answers 400 before any lookup, the same for every id',
  }),
  'GET /api/items/:id/relationships': legacy(),
  'POST /api/items/:id/relationships': legacy({
    body: (v) => ({ label: 'rel', relatedItemId: v.items['data_layer:org'] }),
  }),
  'DELETE /api/items/:id/relationships/:relId': legacy({
    params: { relId: '=00000000-0000-4000-8000-000000000001' },
  }),

  // ---------------------------------------------------------------- OGC and STAC, signed in
  'GET /api/ogc': none(),
  'GET /api/ogc/conformance': none(),
  'GET /api/ogc/collections': list(),
  'GET /api/ogc/collections/:id': read(),
  'GET /api/ogc/collections/:id/items': read(),
  'GET /api/ogc/collections/:id/items/:featureId': read({
    params: { featureId: 'feature' },
    ...NO_CONTROL('collection ids carry a layer suffix the probe does not build'),
  }),
  'GET /api/stac': none(),
  'GET /api/stac/api': none(),
  'GET /api/stac/conformance': none(),
  'GET /api/stac/collections': list(),
  'GET /api/stac/collections/:collectionId': list({
    params: { collectionId: '=rasters' },
    expect: [200, 404],
  }),
  'GET /api/stac/collections/:collectionId/items': list({
    params: { collectionId: '=rasters' },
    expect: [200, 404],
  }),
  'GET /api/stac/collections/:collectionId/items/:itemId': read({
    params: { collectionId: '=rasters', itemId: 'tile_layer:private' },
    ...NO_CONTROL('no raster seeded'),
  }),
  'GET /api/stac/search': list(),
  'POST /api/stac/search': list({ body: () => ({}) }),

  // ---------------------------------------------------------------- OSM
  'GET /api/osm/query': skip('no-tenant-data', 'queries the outside Overpass service'),
  'POST /api/osm/save-as-data-layer': own({
    body: () => ({
      title: 'B osm',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      ],
    }),
    expect: [200, 201, 400],
  }),

  // ---------------------------------------------------------------- PostGIS live
  'POST /api/postgis-live/:serviceItemId/features': write({
    body: () => ({ tableName: 'parcels' }),
  }),
  'POST /api/postgis-live/:serviceItemId/probe': write(),
  'POST /api/postgis-live/create': skip('org-private', 'connects to an outside database'),
  'POST /api/postgis-live/test-connection': skip('org-private', 'connects to an outside database'),
  'POST /api/services/probe': skip('no-tenant-data', 'probes an outside URL'),

  // ---------------------------------------------------------------- print
  'POST /api/print/render': write({
    body: (v) => ({ templateId: v.items['print_template:private'], mapId: ids(v).map }),
    expect: [404, 503],
  }),
  'POST /api/print/consume-render-token': pubNone({
    body: () => ({ token: 'not-a-token' }),
    expect: [400, 401, 403, 404],
  }),
  'POST /api/print/internal/load-job': pubNone({
    body: () => ({ token: 'not-a-token' }),
    expect: [400, 401, 403, 404],
  }),

  // ---------------------------------------------------------------- realtime
  'GET /api/realtime/maps/:mapId/presence': read(),
  'POST /api/realtime/maps/:mapId/presence/heartbeat': write({ body: () => ({}) }),
  'POST /api/realtime/maps/:mapId/presence/ticket': write({ body: () => ({}) }),
  'POST /api/realtime/maps/:mapId/presence/drawings-ticket': write({
    body: (v) => ({ drawingSetId: v.drawingId }),
  }),
  'POST /api/realtime/maps/:mapId/presence/leave': write({
    body: () => ({ connectionId: 'conn-1' }),
  }),
  'DELETE /api/realtime/maps/:mapId/presence/:connectionId': write({
    params: { connectionId: '=conn-1' },
  }),

  // ---------------------------------------------------------------- scripts
  'GET /api/scripts/:id/runs': read({
    params: { id: 'script:private' },
    control: [200, 404],
    reason: 'scripts are off here',
  }),
  'GET /api/scripts/runs/:runId': read({ params: { runId: 'job:script' } }),
  'POST /api/scripts/:id/run': write({ params: { id: 'script:private' } }),
  'POST /api/scripts/runs/:runId/cancel': write({ params: { runId: 'job:script' } }),

  // ---------------------------------------------------------------- storage, map icons, tools
  'GET /api/storage/private/:kind/:key': pub({
    params: { kind: '=feature-attachment', key: 'attachmentKey' },
    control: 'skip',
    reason: 'the attachment bytes are not in storage here',
  }),
  'POST /api/storage/presign-upload': own({
    body: () => ({ kind: 'item-thumb', contentType: 'image/png', sizeBytes: 10 }),
  }),
  'GET /api/map-icons': list(),
  'POST /api/map-icons': skip('org-private', 'multipart upload; no foreign id'),
  'DELETE /api/map-icons/:id': write({ params: { id: '=00000000-0000-4000-8000-000000000001' } }),
  'POST /api/tools/:id/run': pub({
    params: { id: 'tool:private' },
    body: () => ({}),
    ...NO_CONTROL('tools need a recipe'),
  }),

  // ---------------------------------------------------------------- public, signed out
  'GET /api/public/landing': pubList(),
  'GET /api/public/catalog.json': pubList(),
  'GET /api/public/embed-origins': pubList(),
  'GET /api/public/items': pubList(),
  'GET /api/public/items/:id': pub(),
  'GET /api/public/items/:id/layers/:layerId/aggregate': pub({ query: { agg: '=count' } }),
  'GET /api/public/items/:id/layers/:layerId/features': pub(),
  'GET /api/public/items/:id/layers/:layerId/features-page': pub(),
  'GET /api/public/items/:id/layers/:layerId/features-search': pub({ query: { q: '=open' } }),
  'GET /api/public/items/:id/layers/:layerId/filtered-extent': pub(),
  'GET /api/public/items/:id/layers/:layerId/geojson': pub(),
  'GET /api/public/items/:id/layers/:layerId/tile/:z/:x/:y.mvt': pub(),
  'GET /api/public/items/:id/layers/:layerId/tilejson.json': pub(),
  'GET /api/public/items/:id/proxy': pub({
    params: { id: 'service:private' },
    ...NO_CONTROL('the service has no upstream URL here'),
  }),
  'GET /api/public/items/:id/proxy/*': pub({
    params: { id: 'service:private' },
    ...NO_CONTROL('the service has no upstream URL here'),
  }),
  'GET /api/public/csw': pubNone(),
  'GET /api/public/ogc': pubNone(),
  'GET /api/public/ogc/api': pubNone(),
  'GET /api/public/ogc/conformance': pubNone(),
  'GET /api/public/ogc/collections': pubNone(),
  'GET /api/public/ogc/collections/:id': pub({
    ...NO_CONTROL('collection ids carry a layer suffix the probe does not build'),
  }),
  'GET /api/public/ogc/collections/:id/items': pub({
    ...NO_CONTROL('collection ids carry a layer suffix the probe does not build'),
  }),
  'GET /api/public/ogc/collections/:id/items/:featureId': pub({
    params: { featureId: 'feature' },
    ...NO_CONTROL('collection ids carry a layer suffix the probe does not build'),
  }),
  'GET /api/public/ogc/collections/:collectionId/tiles': pub({
    ...NO_CONTROL('collection ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/collections/:collectionId/tiles/:tmsId': pub({
    params: { tmsId: '=WebMercatorQuad' },
    ...NO_CONTROL('collection ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/collections/:collectionId/tiles/:tmsId/:tileMatrix/:tileRow/:tileCol': pub({
    params: { tmsId: '=WebMercatorQuad' },
    ...NO_CONTROL('collection ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/collections/:collectionId/tiles/:tmsId/tilejson.json': pub({
    params: { tmsId: '=WebMercatorQuad' },
    ...NO_CONTROL('collection ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/collections/catalog': pubNone(),
  'GET /api/public/ogc/collections/catalog/items': pubNone(),
  'GET /api/public/ogc/collections/catalog/items/:recordId': pub({
    params: { recordId: 'data_layer:private' },
  }),
  'GET /api/public/ogc/records': pubNone(),
  'GET /api/public/ogc/records/:recordId': pub({ params: { recordId: 'data_layer:private' } }),
  'GET /api/public/ogc/aardvark/:itemId.json': pub(),
  'GET /api/public/ogc/citation/:itemId.bib': pub(),
  'GET /api/public/ogc/citation/:itemId.jsonld': pub(),
  'GET /api/public/ogc/citation/:itemId.ris': pub(),
  'GET /api/public/ogc/styles': pubNone(),
  'GET /api/public/ogc/styles/:styleId': pub({
    params: { styleId: 'data_layer:private' },
    ...NO_CONTROL('style ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/styles/:styleId/metadata': pub({
    params: { styleId: 'data_layer:private' },
    ...NO_CONTROL('style ids carry a layer suffix'),
  }),
  'GET /api/public/ogc/tileMatrixSets': none(),
  'GET /api/public/ogc/tileMatrixSets/:tmsId': none({ params: { tmsId: '=WebMercatorQuad' } }),
  'GET /api/public/stac': pubNone(),
  'GET /api/public/stac/api': pubNone(),
  'GET /api/public/stac/conformance': pubNone(),
  'GET /api/public/stac/collections': pubNone(),
  'GET /api/public/stac/collections/:collectionId': pubNone({
    params: { collectionId: '=rasters' },
    expect: [200, 404],
  }),
  'GET /api/public/stac/collections/:collectionId/items': pubNone({
    params: { collectionId: '=rasters' },
    expect: [200, 404],
  }),
  'GET /api/public/stac/collections/:collectionId/items/:itemId': pub({
    params: { collectionId: '=rasters', itemId: 'tile_layer:private' },
    ...NO_CONTROL('no raster seeded'),
  }),
  'GET /api/public/stac/search': pubNone(),
  'POST /api/public/stac/search': pubNone({ body: () => ({}) }),
  'POST /api/feedback': skip('no-tenant-data', 'anonymous feedback form; sends mail'),
  'POST /api/areas-of-interest': skip('no-tenant-data', "What's Here area resolve (#796): stores a shape only, no org, reads no table"),

  // ---------------------------------------------------------------- users, keys, preferences
  'GET /api/users': list(),
  'GET /api/users/me': list(),
  'PATCH /api/users/me': own({ body: () => ({ firstName: 'Bee' }) }),
  'GET /api/users/me/api-keys': list(),
  'POST /api/users/me/api-keys': own({ body: () => ({ name: 'B extra key' }) }),
  'DELETE /api/users/me/api-keys/:id': write({
    params: { id: 'apiKey' },
    expect: [401, 404],
    reason: "answers 401 for any key that is not the caller's",
  }),
  'GET /api/users/me/notification-preferences': list(),
  'PUT /api/users/me/notification-preferences': own({
    body: () => ({ type: 'share_created', channel: 'email', enabled: false }),
  }),
  'POST /api/field/queue-manifest': own({
    body: () => ({ deviceFingerprint: 'device-b', manifest: [] }),
  }),
};

/** Default fixture refs for path parameters, by name. */
export const DEFAULT_PARAMS: Record<string, Ref> = {
  id: 'data_layer:private',
  itemId: 'data_layer:private',
  mapId: 'map:private',
  serviceItemId: 'service:private',
  collectionId: 'data_layer:private',
  childItemId: 'data_layer:org',
  layerId: '=sites',
  fid: 'feature',
  featureId: 'feature',
  attId: 'attachment',
  threadId: 'thread',
  commentId: 'reply',
  drawingId: 'drawing',
  snapshotId: 'snapshot',
  userId: 'user:contributor',
  jobId: 'job:import',
  runId: 'job:script',
  packageId: 'job:offline',
  areaId: '=area-1',
  z: '=0',
  x: '=0',
  y: '=0',
  gx: '=0',
  gy: '=0',
  tileMatrix: '=0',
  tileRow: '=0',
  tileCol: '=0',
};

export const OK_STATUSES = OK;
