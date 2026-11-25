// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two organizations, A and B, with the same shape of content, for the
// isolation suites. Users and job rows are written with SQL; content
// is created through the API itself, as each org's own users, so it
// has the shape the product gives it.
//
// Both orgs use the same item titles on purpose: name lookups must
// find the caller's own item, never the other org's.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { ITEM_TYPES } from '@gratis-gis/shared-types';

import { signTestToken, testFetch } from './harness.js';

export type OrgKey = 'A' | 'B' | 'OP';
export type Role = 'admin' | 'contributor' | 'viewer';
export type Access = 'private' | 'org' | 'public';

export type FixtureUser = {
  id: string;
  username: string;
  email: string;
  role: Role;
  orgKey: OrgKey;
  token: string;
};

export type OrgFixture = {
  key: OrgKey;
  orgId: string;
  slug: string;
  users: Record<Role, FixtureUser>;
  groupId: string;
  /** `${type}:${access}` to item id, for every item the API created. */
  items: Record<string, string>;
  /** Item types the API refused to create from the minimal payload. */
  skippedTypes: string[];
  layerId: string;
  /** Features of the private data layer. */
  featureIds: string[];
  /** Features of the public data layer. */
  publicFeatureIds: string[];
  attachmentId: string | null;
  /** The attachment's storage key, without the kind prefix. */
  attachmentKey: string;
  threadId: string | null;
  replyId: string | null;
  drawingId: string | null;
  snapshotId: string | null;
  apiKeyId: string | null;
  apiKeyToken: string | null;
  mapIconId: string | null;
  jobs: Record<string, string>;
  notificationId: string;
  /** Strings that must never reach a caller of the other org. */
  secrets: string[];
  /** Ids of this org's public items: other orgs may see these on public routes. */
  publicIds: string[];
};

export type Fixtures = { A: OrgFixture; B: OrgFixture; OP: OrgFixture; baseUrl: string };

/** Stable ids, so a failing run can be read against the database. */
const ORG_IDS: Record<OrgKey, string> = {
  A: '1a000000-0000-4000-8000-00000000000a',
  B: '1b000000-0000-4000-8000-00000000000b',
  OP: '1c000000-0000-4000-8000-00000000000c',
};
const ROLE_SUFFIX: Record<Role, string> = { admin: '1', contributor: '2', viewer: '3' };

export const LAYER_ID = 'sites';

/** A marker written into every private and org-only text of an org. */
export function marker(key: OrgKey): string {
  return `only-org-${key.toLowerCase()}-marker`;
}

export function userId(org: OrgKey, role: Role): string {
  return ORG_IDS[org].slice(0, -1) + ROLE_SUFFIX[role];
}

export function orgId(org: OrgKey): string {
  return ORG_IDS[org];
}

export function tokenFor(u: Omit<FixtureUser, 'token'>, slug: string): string {
  return signTestToken({
    sub: u.id,
    preferred_username: u.username,
    email: u.email,
    name: u.username,
    org: slug,
    org_role: u.role,
  });
}

export type ApiResult = { status: number; body: unknown; text: string; headers: Headers };

/** One request to the app as a fixture user (or signed out with null). */
export async function api(
  baseUrl: string,
  user: { token: string } | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (user) headers.authorization = `Bearer ${user.token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await testFetch(baseUrl + path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
    redirect: 'manual',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let parsed: unknown = undefined;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function must<T>(r: ApiResult, what: string): T {
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`seed: ${what} answered ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.body as T;
}

/** A map layer that shows one sublayer of a v3 data layer. */
export function mapLayer(id: string, itemId: string): Record<string, unknown> {
  return {
    id,
    name: 'Sites',
    visible: true,
    source: { kind: 'data-layer', itemId, layerKey: LAYER_ID },
  };
}

/** Minimal item data per type. Types missing here get `{}`. */
function itemData(type: string, layerItemId: string | undefined): Record<string, unknown> {
  switch (type) {
    case 'data_layer':
      return {
        version: 3,
        layers: [
          {
            id: LAYER_ID,
            name: 'Sites',
            geometryType: 'point',
            fields: [
              { name: 'status', type: 'string', label: 'Status', nullable: true },
              { name: 'note', type: 'string', label: 'Note', nullable: true },
            ],
          },
        ],
      };
    case 'map':
      return layerItemId ? { layers: [mapLayer('l1', layerItemId)] } : {};
    case 'derived_layer':
      return layerItemId
        ? {
            version: 1,
            source: { kind: 'data_layer', itemId: layerItemId, layerKey: LAYER_ID },
            pipeline: [
              { tool: 'buffer', params: { mode: 'fixed', distance: 100, unit: 'meters' } },
            ],
            featureLimit: 1000,
            outputSchema: [],
            bbox: [],
          }
        : {};
    default:
      return {};
  }
}

async function seedOrg(pool: Pool, baseUrl: string, key: OrgKey): Promise<OrgFixture> {
  const id = ORG_IDS[key];
  const slug = `iso-${key.toLowerCase()}`;
  await pool.query(
    `INSERT INTO organization (id, slug, name, created_at) VALUES ($1, $2, $3, $4)`,
    [
      id,
      slug,
      `Isolation ${key}`,
      // A is the oldest: the install org in single mode.
      new Date(Date.UTC(2020, 0, key === 'A' ? 1 : key === 'B' ? 2 : 3)),
    ],
  );
  const users = {} as Record<Role, FixtureUser>;
  for (const role of ['admin', 'contributor', 'viewer'] as const) {
    const u = {
      id: userId(key, role),
      username: `iso-${key.toLowerCase()}-${role}`,
      email: `iso-${key.toLowerCase()}-${role}@example.test`,
      role,
      orgKey: key,
    };
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role) VALUES ($1, $2, $3, $4, $3, $5)`,
      [u.id, id, u.username, u.email, role],
    );
    users[role] = { ...u, token: tokenFor(u, slug) };
  }

  const fx: OrgFixture = {
    key,
    orgId: id,
    slug,
    users,
    groupId: '',
    items: {},
    skippedTypes: [],
    layerId: LAYER_ID,
    featureIds: [],
    publicFeatureIds: [],
    attachmentId: null,
    attachmentKey: '',
    threadId: null,
    replyId: null,
    drawingId: null,
    snapshotId: null,
    apiKeyId: null,
    apiKeyToken: null,
    mapIconId: null,
    jobs: {},
    notificationId: '',
    secrets: [marker(key)],
    publicIds: [],
  };
  if (key === 'OP') {
    // Warm the sign-in so the operator's own built-ins exist.
    must(await api(baseUrl, users.admin, 'GET', '/api/users/me'), 'operator me');
    return fx;
  }
  const admin = users.admin;
  for (const u of Object.values(users)) {
    must(await api(baseUrl, u, 'GET', '/api/users/me'), `${u.username} me`);
    // The admin owns the public items, whose owner is public by design.
    fx.secrets.push(u.email);
    if (u.role !== 'admin') fx.secrets.push(u.id, u.username);
  }

  const group = must<{ id: string }>(
    await api(baseUrl, admin, 'POST', '/api/groups', {
      title: 'Field crew',
      description: `crew ${marker(key)}`,
      access: 'org',
    }),
    'group',
  );
  fx.groupId = group.id;
  fx.secrets.push(group.id);
  must(
    await api(baseUrl, admin, 'POST', `/api/groups/${group.id}/members`, {
      userId: users.contributor.id,
    }),
    'group member',
  );

  // One item of every type at each access level. The data layer goes
  // first so the map can point at it.
  const order = ['data_layer', ...ITEM_TYPES.filter((t) => t !== 'data_layer')];
  for (const type of order) {
    for (const access of ['private', 'org', 'public'] as const) {
      const r = await api(baseUrl, admin, 'POST', '/api/items', {
        type,
        title: `Shared title ${type} ${access}`,
        description: access === 'public' ? 'Public item' : `Description ${marker(key)}`,
        access,
        data: itemData(type, fx.items[`data_layer:${access}`]),
      });
      if (r.status >= 200 && r.status < 300) {
        const itemId = (r.body as { id: string }).id;
        fx.items[`${type}:${access}`] = itemId;
        if (access === 'public') fx.publicIds.push(itemId);
        else fx.secrets.push(itemId);
      } else if (!fx.skippedTypes.includes(type)) {
        fx.skippedTypes.push(type);
      }
    }
  }

  // Features in the private and the public layer.
  for (const access of ['private', 'public'] as const) {
    const layer = fx.items[`data_layer:${access}`];
    if (!layer) throw new Error('seed: the data layer was not created');
    const created = must<unknown>(
      await api(baseUrl, admin, 'POST', `/api/items/${layer}/layers/${LAYER_ID}/features`, {
        features: [
          {
            geometry: { type: 'Point', coordinates: pointFor(key, access, 0) },
            properties: { status: 'open', note: access === 'public' ? 'public row' : marker(key) },
          },
          {
            geometry: { type: 'Point', coordinates: pointFor(key, access, 0.1) },
            properties: {
              status: 'closed',
              note: access === 'public' ? 'public row' : marker(key),
            },
          },
        ],
      }),
      `features ${access}`,
    );
    const ids = featureIdsOf(created);
    if (access === 'private') {
      fx.featureIds = ids;
      fx.secrets.push(...ids);
    } else {
      fx.publicFeatureIds = ids;
    }
  }

  const layer = fx.items['data_layer:private']!;
  const map = fx.items['map:private'];

  // Share the private layer with the group (view).
  must(
    await api(baseUrl, admin, 'POST', `/api/items/${layer}/share`, {
      principalType: 'group',
      principalId: fx.groupId,
      permission: 'view',
    }),
    'share',
  );

  // A comment thread with one reply on the private layer.
  const thread = await api(baseUrl, admin, 'POST', `/api/items/${layer}/comments`, {
    body: `Thread ${marker(key)}`,
    parentKind: 'layer',
    parentId: LAYER_ID,
  });
  if (thread.status < 300) {
    fx.threadId = idOf(thread.body, ['id', 'threadId', 'thread.id']);
    if (fx.threadId) {
      fx.secrets.push(fx.threadId);
      const reply = await api(
        baseUrl,
        admin,
        'POST',
        `/api/items/${layer}/comments/${fx.threadId}/replies`,
        {
          body: `Reply ${marker(key)}`,
        },
      );
      if (reply.status < 300) fx.replyId = idOf(reply.body, ['id', 'comment.id']);
    }
  }

  // A drawing on the private map.
  if (map) {
    const drawing = await api(baseUrl, admin, 'POST', `/api/items/${map}/drawings`, {
      title: `Drawing ${marker(key)}`,
      features: [],
    });
    if (drawing.status < 300) fx.drawingId = idOf(drawing.body, ['id', 'drawing.id']);
  }

  // A snapshot: saving the private layer's item data makes one.
  const current = must<{ data: unknown }>(
    await api(baseUrl, admin, 'GET', `/api/items/${layer}`),
    'read layer',
  );
  must(
    await api(baseUrl, admin, 'PATCH', `/api/items/${layer}`, {
      description: `Edited ${marker(key)}`,
      data: current.data,
    }),
    'edit',
  );
  const snaps = await api(baseUrl, admin, 'GET', `/api/items/${layer}/snapshots`);
  if (snaps.status === 200) fx.snapshotId = firstId(snaps.body);

  // A personal API key for the admin.
  const key1 = await api(baseUrl, admin, 'POST', '/api/users/me/api-keys', { name: `key ${key}` });
  if (key1.status < 300) {
    const b = key1.body as { id: string; token: string };
    fx.apiKeyId = b.id;
    fx.apiKeyToken = b.token;
    fx.secrets.push(b.id);
  }

  // Job rows, one in each job table, and a notification.
  const ins = async (sql: string, params: unknown[]): Promise<string> =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  fx.jobs.import = await ins(
    `INSERT INTO import_job (item_id, layer_id, staging_id, source_file_name, source_layer_name, mode, created_by, org_id, status)
     VALUES ($1, $2, 'stage-1', 'sites.geojson', 'sites', 'append', $3, $4, 'succeeded') RETURNING id`,
    [layer, LAYER_ID, admin.id, id],
  );
  fx.jobs.analysis = await ins(
    `INSERT INTO analysis_job (org_id, user_id, kind, source_item_id, state) VALUES ($1, $2, 'hillshade', $3, 'succeeded') RETURNING id`,
    [id, admin.id, layer],
  );
  fx.jobs.agoImport = await ins(
    `INSERT INTO ago_import_job (created_by, org_id, status, portal_url, request_payload)
     VALUES ($1, $2, 'succeeded', 'https://example.test', '{}'::jsonb) RETURNING id`,
    [admin.id, id],
  );
  if (map) {
    fx.jobs.offline = await ins(
      `INSERT INTO offline_package (org_id, item_id, area_id, created_by, status, bbox, min_zoom, max_zoom, source_url)
       VALUES ($1, $2, 'area-1', $3, 'ready', ARRAY[-118,33,-116,35]::double precision[], 1, 10, 'https://example.test/{z}/{x}/{y}.png') RETURNING id`,
      [id, map, admin.id],
    );
  }
  const script = fx.items['script:private'];
  if (script) {
    fx.jobs.script = await ins(
      `INSERT INTO script_run (id, script_id, org_id, user_id, state) VALUES (gen_random_uuid(), $1, $2, $3, 'succeeded') RETURNING id`,
      [script, id, admin.id],
    );
  }
  for (const v of Object.values(fx.jobs)) fx.secrets.push(v);
  fx.attachmentKey = randomUUID();
  fx.secrets.push(fx.attachmentKey);
  // An attachment on the first private feature. The bytes live in the
  // in-memory store under the same key.
  fx.attachmentId = await ins(
    `INSERT INTO feature_attachment (item_id, layer_id, feature_id, file_name, mime, size_bytes, storage_key, storage_url, created_by)
     VALUES ($1, $2, $3, 'photo.txt', 'text/plain', 5, $4, $5, $6) RETURNING id`,
    [
      layer,
      LAYER_ID,
      fx.featureIds[0],
      `feature-attachment/${fx.attachmentKey}`,
      `/api/portal/storage/private/feature-attachment/${fx.attachmentKey}`,
      admin.id,
    ],
  );
  fx.secrets.push(fx.attachmentId);
  // The attachment's key is in the older layout, with no org in it. As
  // after the usage backfill, the ledger records which org owns it;
  // with many organizations that row is what lets its owner read it.
  await ins(
    `INSERT INTO storage_object (key, org_id, kind, bytes, item_id)
     VALUES ($1, $2, 'feature-attachment', 5, $3) RETURNING key AS id`,
    [`feature-attachment/${fx.attachmentKey}`, id, layer],
  );
  // The ledger has been filled once, as after the first fill on a
  // real install, so the strict rule for older keys applies.
  await ins(
    `INSERT INTO system_setting (key, value) VALUES ('storage_usage.ledger_filled', '{"at":"seed"}'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING key AS id`,
    [],
  );
  fx.notificationId = await ins(
    `INSERT INTO notification (user_id, type, payload, channel, address, status)
     VALUES ($1, 'share-created', $2::jsonb, 'email', $3, 'sent') RETURNING id`,
    [admin.id, JSON.stringify({ note: marker(key) }), admin.email],
  );
  fx.secrets.push(fx.notificationId);
  return fx;
}

/**
 * Where each layer's features sit. The private layers of A and B are
 * far apart and far from the public ones, so an extent or a clip that
 * used another org's private layer shows up in a bbox.
 */
export const AREAS = {
  A: { private: [10, 50], public: [-117, 34] },
  B: { private: [140, -35], public: [-116.5, 34] },
} as const;

function pointFor(key: OrgKey, access: 'private' | 'public', offset: number): [number, number] {
  const [x, y] = AREAS[key === 'B' ? 'B' : 'A'][access];
  return [x + offset, y + offset];
}

function featureIdsOf(body: unknown): string[] {
  const listed = (body as { globalIds?: unknown } | undefined)?.globalIds;
  if (Array.isArray(listed)) return listed.filter((v): v is string => typeof v === 'string');
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['globalId', 'id', 'fid']) {
        if (typeof o[k] === 'string' && /^[0-9a-f-]{36}$/i.test(o[k] as string)) {
          out.push(o[k] as string);
          break;
        }
      }
      for (const val of Object.values(o)) if (typeof val === 'object') visit(val);
    }
  };
  visit(body);
  return [...new Set(out)];
}

function idOf(body: unknown, paths: string[]): string | null {
  for (const p of paths) {
    let v: unknown = body;
    for (const part of p.split('.'))
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    if (typeof v === 'string') return v;
  }
  return null;
}

function firstId(body: unknown): string | null {
  const list = Array.isArray(body)
    ? body
    : (body as { snapshots?: unknown[] } | undefined)?.snapshots;
  const first = Array.isArray(list) ? (list[0] as { id?: string } | undefined) : undefined;
  return first?.id ?? null;
}

export async function seedTwoOrgs(
  databaseUrl: string,
  baseUrl: string,
  realm?: {
    add(u: { id: string; username: string; email: string; org: string; orgRole: string }): void;
  },
): Promise<Fixtures> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const A = await seedOrg(pool, baseUrl, 'A');
    const B = await seedOrg(pool, baseUrl, 'B');
    const OP = await seedOrg(pool, baseUrl, 'OP');
    for (const fx of [A, B, OP]) {
      for (const u of Object.values(fx.users)) {
        realm?.add({
          id: u.id,
          username: u.username,
          email: u.email,
          org: fx.slug,
          orgRole: u.role,
        });
      }
    }
    return { A, B, OP, baseUrl };
  } finally {
    await pool.end();
  }
}
