// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Isolation cases that do not fit one row of the route table: the
// harness checking itself, signed-in and signed-out portal info, the
// per-org embed origins, boundary clips, map extents, map references
// and the realtime socket. Each case returns a verdict; KNOWN_GAPS
// keys for these start with `topic:`.

import WebSocket from 'ws';

import type { TenancyMode } from '../../common/tenancy.js';
import { changedTables, fingerprint } from './fingerprint.js';
import { AppModule } from '../../app.module.js';
import { discoverRoutes } from './route-discovery.js';
import { STORAGE_TOPICS } from './storage-topics.js';
import { AREAS, LAYER_ID, api, mapLayer, tokenFor, type ApiResult } from './seed.js';
import type { SuiteState, Verdict } from './suite.js';

type Topic = {
  name: string;
  modes: TenancyMode[];
  run(state: SuiteState): Promise<Verdict>;
};

const BOTH: TenancyMode[] = ['single', 'multi'];

const short = (r: ApiResult): string => `${r.status} ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`;

function verdict(problems: string[]): Verdict {
  return { ok: problems.length === 0, problems };
}

function asKey(token: string): { token: string } {
  return { token };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** The stored bbox of an item, read by its owner, after background refreshes settle. */
async function bboxOf(state: SuiteState, owner: { token: string }, id: string): Promise<number[]> {
  let last: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await api(state.app.baseUrl, owner, 'GET', `/api/items/${id}`);
    last = ((r.body as { bbox?: number[] } | undefined)?.bbox ?? []).map(Number);
    if (last.length === 4) return last;
    await sleep(150);
  }
  return last;
}

function covers(bbox: number[], point: readonly number[]): boolean {
  if (bbox.length !== 4) return false;
  const [w, s, e, n] = bbox as [number, number, number, number];
  return point[0]! >= w && point[0]! <= e && point[1]! >= s && point[1]! <= n;
}

function square(center: readonly number[], half: number): unknown {
  const [x, y] = center as [number, number];
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x - half, y - half],
        [x + half, y - half],
        [x + half, y + half],
        [x - half, y + half],
        [x - half, y - half],
      ],
    ],
  };
}

function featureCount(r: ApiResult): number {
  const fc = r.body as { features?: unknown[] } | undefined;
  return Array.isArray(fc?.features) ? fc.features.length : -1;
}

async function createItem(
  state: SuiteState,
  who: { token: string },
  body: Record<string, unknown>,
): Promise<{ res: ApiResult; id: string | null }> {
  const res = await api(state.app.baseUrl, who, 'POST', '/api/items', body);
  const id = res.status < 300 ? ((res.body as { id?: string }).id ?? null) : null;
  return { res, id };
}

function mapData(layerItemId: string): Record<string, unknown> {
  return { layers: [mapLayer('l1', layerItemId)] };
}

/** Open a socket and report whether the server let it join (sent a roster) or closed it. */
async function joinRoom(
  baseUrl: string,
  mapId: string,
  ticket: string,
): Promise<'joined' | 'closed'> {
  const url = `${baseUrl.replace('http', 'ws')}/api/realtime/ws?mapId=${encodeURIComponent(mapId)}&ticket=${encodeURIComponent(ticket)}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v: 'joined' | 'closed'): void => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => done('closed'), 3000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type === 'roster') done('joined');
    });
    ws.on('close', () => done('closed'));
    ws.on('error', () => done('closed'));
  });
}

async function ticketFor(
  state: SuiteState,
  who: { token: string },
  mapId: string,
): Promise<string | null> {
  const r = await api(
    state.app.baseUrl,
    who,
    'POST',
    `/api/realtime/maps/${mapId}/presence/ticket`,
    {},
  );
  return r.status < 300 ? ((r.body as { ticket?: string }).ticket ?? null) : null;
}

export const TOPICS: Topic[] = [
  {
    name: 'harness: each test identity resolves to its own org',
    modes: BOTH,
    async run({ app, fx }) {
      const p: string[] = [];
      for (const org of [fx.A, fx.B]) {
        const r = await api(app.baseUrl, org.users.viewer, 'GET', '/api/users/me');
        if ((r.body as { orgId?: string } | undefined)?.orgId !== org.orgId)
          p.push(`${org.key}: ${short(r)}`);
      }
      const anon = await api(app.baseUrl, null, 'GET', '/api/items');
      if (anon.status !== 401)
        p.push(`signed out on a private route: expected 401, got ${anon.status}`);
      return verdict(p);
    },
  },
  {
    name: 'harness: a token naming another org cannot move a user there',
    modes: ['multi'],
    async run({ app, fx }) {
      const u = fx.A.users.viewer;
      const forged = tokenFor(u, fx.B.slug);
      const r = await api(app.baseUrl, asKey(forged), 'GET', '/api/users/me');
      const again = await api(app.baseUrl, u, 'GET', '/api/users/me');
      const p: string[] = [];
      if (r.status !== 401) p.push(`expected 401, got ${short(r)}`);
      if ((again.body as { orgId?: string } | undefined)?.orgId !== fx.A.orgId)
        p.push('the user changed org');
      return verdict(p);
    },
  },
  {
    name: 'harness: the fingerprint sees a change made by the owning org',
    modes: BOTH,
    async run({ app, fx, pool }) {
      const before = await fingerprint(pool, fx.A.orgId);
      const id = fx.A.items['file:org']!;
      const r = await api(app.baseUrl, fx.A.users.admin, 'PATCH', `/api/items/${id}`, {
        title: 'Touched by A',
      });
      const changed = changedTables(before, await fingerprint(pool, fx.A.orgId));
      const p: string[] = [];
      if (r.status !== 200) p.push(`A's own edit failed: ${short(r)}`);
      if (!changed.includes('item'))
        p.push(`the item table did not change (${changed.join(', ')})`);
      return verdict(p);
    },
  },
  {
    name: 'harness: API keys get the same answers through the real key check',
    modes: BOTH,
    async run({ app, fx }) {
      const p: string[] = [];
      const keyA = asKey(fx.A.apiKeyToken!);
      const keyB = asKey(fx.B.apiKeyToken!);
      const id = fx.A.items['data_layer:private']!;
      const own = await api(app.baseUrl, keyA, 'GET', `/api/items/${id}`);
      const other = await api(app.baseUrl, keyB, 'GET', `/api/items/${id}`);
      const list = await api(app.baseUrl, keyB, 'GET', '/api/items');
      if (own.status !== 200) p.push(`A's key on A's item: ${short(own)}`);
      if (other.status !== 404) p.push(`B's key on A's item: expected 404, got ${short(other)}`);
      const leaks = fx.A.secrets.filter((s) => list.text.includes(s));
      if (leaks.length) p.push(`B's key listing saw A's data: ${leaks.join(', ')}`);
      return verdict(p);
    },
  },
  {
    name: 'harness: the route table matches the router the app registered',
    modes: BOTH,
    async run({ app }) {
      type Layer = { route?: { path: string; methods: Record<string, boolean> } };
      const express = app.app.getHttpAdapter().getInstance() as { router?: { stack: Layer[] } };
      const live = new Set<string>();
      for (const layer of express.router?.stack ?? []) {
        if (!layer.route) continue;
        // A handler for every method (`all`) is framework plumbing, not a route.
        if (Object.keys(layer.route.methods).length > 8) continue;
        const path = layer.route.path.replace(/\{\*[^}]*\}|\*[A-Za-z]+$/g, '*');
        for (const [m, on] of Object.entries(layer.route.methods)) {
          if (on && m !== '_all') live.add(`${m.toUpperCase()} ${path}`);
        }
      }
      const discovered = new Set(discoverRoutes(AppModule).map((r) => r.key));
      const missing = [...live].filter((k) => !discovered.has(k));
      const extra = [...discovered].filter((k) => !live.has(k));
      return verdict([
        ...(missing.length ? [`registered but not discovered: ${missing.join(', ')}`] : []),
        ...(extra.length ? [`discovered but not registered: ${extra.join(', ')}`] : []),
      ]);
    },
  },
  {
    name: "portal-info names the caller's own org",
    modes: BOTH,
    async run({ app, fx, mode }) {
      const p: string[] = [];
      const a = await api(app.baseUrl, fx.A.users.viewer, 'GET', '/api/portal-info');
      const b = await api(app.baseUrl, fx.B.users.viewer, 'GET', '/api/portal-info');
      const anon = await api(app.baseUrl, null, 'GET', '/api/portal-info');
      const name = (r: ApiResult): string | undefined =>
        (r.body as { name?: string } | undefined)?.name;
      // Single mode names the install's org for everyone, as before.
      const expectB = mode === 'multi' ? 'Isolation B' : 'Isolation A';
      if (name(a) !== 'Isolation A') p.push(`A: ${short(a)}`);
      if (name(b) !== expectB) p.push(`B: ${short(b)}`);
      if (mode === 'multi' && (name(anon) === 'Isolation A' || name(anon) === 'Isolation B')) {
        p.push(`signed out in multi mode named an org: ${short(anon)}`);
      }
      if (mode === 'single' && name(anon) !== 'Isolation A')
        p.push(`signed out in single mode: ${short(anon)}`);
      return verdict(p);
    },
  },
  {
    name: "embed origins are each org's own, and public only for the named org",
    modes: BOTH,
    async run({ app, fx, mode }) {
      const p: string[] = [];
      const put = await api(
        app.baseUrl,
        fx.A.users.admin,
        'PUT',
        '/api/admin/security/embed-origins',
        {
          origins: ['https://a-only.example.test'],
        },
      );
      if (put.status !== 200) p.push(`A set its origins: ${short(put)}`);
      const bAdmin = await api(
        app.baseUrl,
        fx.B.users.admin,
        'GET',
        '/api/admin/security/embed-origins',
      );
      if (mode === 'multi' && (bAdmin.status !== 200 || bAdmin.text.includes('a-only'))) {
        p.push(`B's admin list: ${short(bAdmin)}`);
      }
      if (mode === 'single' && bAdmin.status !== 403)
        p.push(`B's admin in single mode: ${short(bAdmin)}`);
      const pubA = await api(
        app.baseUrl,
        null,
        'GET',
        `/api/public/embed-origins?org=${fx.A.slug}`,
      );
      const pubB = await api(
        app.baseUrl,
        null,
        'GET',
        `/api/public/embed-origins?org=${fx.B.slug}`,
      );
      const none = await api(app.baseUrl, null, 'GET', '/api/public/embed-origins');
      if (!pubA.text.includes('a-only')) p.push(`?org=A: ${short(pubA)}`);
      // Single mode keeps one install-wide list, the same for every slug.
      if (mode === 'multi' && pubB.text.includes('a-only')) {
        p.push(`?org=B shows A's origins: ${short(pubB)}`);
      }
      if (mode === 'single' && !pubB.text.includes('a-only'))
        p.push(`single mode, ?org=B: ${short(pubB)}`);
      if (mode === 'multi' && none.status !== 404) p.push(`no ?org= in multi mode: ${short(none)}`);
      return verdict(p);
    },
  },
  {
    name: 'a boundary clip from another org applies only when it is public',
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      // Boundaries of A around nothing B has: if one is applied to B's
      // layer, B's features disappear.
      const far = square([0, 0], 1);
      const privateB = await createItem(state, fx.A.users.admin, {
        type: 'geo_boundary',
        title: 'A private boundary',
        access: 'private',
        data: { geometry: far },
      });
      const publicB = await createItem(state, fx.A.users.admin, {
        type: 'geo_boundary',
        title: 'A public boundary',
        access: 'public',
        data: { geometry: far },
      });
      if (!privateB.id || !publicB.id)
        return verdict([`could not create boundaries: ${short(privateB.res)}`]);
      const layer = fx.B.items['data_layer:private']!;
      // The v3 feature route. The item GeoJSON route applies the same
      // helper to per-item tables, which a v3 layer does not have.
      for (const path of [`/api/items/${layer}/layers/${LAYER_ID}/geojson`]) {
        const plain = featureCount(await api(app.baseUrl, fx.B.users.admin, 'GET', path));
        const withPrivate = featureCount(
          await api(app.baseUrl, fx.B.users.admin, 'GET', `${path}?clip=${privateB.id}`),
        );
        const withPublic = featureCount(
          await api(app.baseUrl, fx.B.users.admin, 'GET', `${path}?clip=${publicB.id}`),
        );
        if (plain !== 2) p.push(`${path}: B's own layer has ${plain} features, expected 2`);
        if (withPrivate !== plain)
          p.push(`${path}: A's private boundary changed B's result (${withPrivate})`);
        if (withPublic !== 0) p.push(`${path}: A's public boundary did not apply (${withPublic})`);
      }
      return verdict(p);
    },
  },
  {
    name: "a map extent never uses another org's private layer",
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      const own = fx.B.items['data_layer:private']!;
      const { id } = await createItem(state, fx.B.users.admin, {
        type: 'map',
        title: 'B map with own layer',
        access: 'private',
        data: mapData(own),
      });
      if (!id) return verdict(['B could not create its own map']);
      // Point the map at A's private layer as well and let the refresh run.
      const r = await api(app.baseUrl, fx.B.users.admin, 'PATCH', `/api/items/${id}`, {
        data: {
          layers: [
            ...(mapData(own).layers as unknown[]),
            mapLayer('l2', fx.A.items['data_layer:private']!),
          ],
        },
      });
      if (r.status === 200) {
        await sleep(1500);
        const bbox = await bboxOf(state, fx.B.users.admin, id);
        if (covers(bbox, AREAS.A.private))
          p.push(`B's map extent covers A's private layer: ${bbox.join(',')}`);
        await api(
          app.baseUrl,
          fx.B.users.admin,
          'POST',
          '/api/admin/housekeeping/recompute-extents',
        );
        const after = await bboxOf(state, fx.B.users.admin, id);
        if (covers(after, AREAS.A.private))
          p.push(`after recompute, B's map covers A's private layer: ${after.join(',')}`);
        for (const path of [
          `/api/items/${id}`,
          `/api/items/${id}/web-map.json`,
          `/api/items/${id}/dependencies`,
        ]) {
          const res = await api(app.baseUrl, fx.B.users.admin, 'GET', path);
          const leaks = fx.A.secrets.filter(
            (s) => res.text.includes(s) && s !== fx.A.items['data_layer:private'],
          );
          if (leaks.length) p.push(`${path} shows A's data: ${leaks.join(', ')}`);
        }
      }
      return verdict(p);
    },
  },
  {
    name: 'map save refuses a layer the author cannot read',
    modes: BOTH,
    async run(state) {
      const { fx } = state;
      const { res } = await createItem(state, fx.B.users.admin, {
        type: 'map',
        title: 'B map with A layer',
        access: 'private',
        data: mapData(fx.A.items['data_layer:private']!),
      });
      return verdict(
        res.status < 300 ? [`saved with another org's private layer id: ${res.status}`] : [],
      );
    },
  },
  {
    name: 'map save keeps a layer the author lost access to, and refuses adding one',
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      const admin = fx.B.users.admin;
      const author = fx.B.users.contributor;
      // A layer of B's admin, shared with the author while the map is made.
      const { id: layer } = await createItem(state, admin, {
        type: 'data_layer',
        title: 'B layer shared for a while',
        access: 'private',
        data: { version: 3, layers: [] },
      });
      if (!layer) return verdict(["B's admin could not create a layer"]);
      const share = { principalType: 'user', principalId: author.id, permission: 'view' };
      await api(app.baseUrl, admin, 'POST', `/api/items/${layer}/share`, share);
      const { res, id: map } = await createItem(state, author, {
        type: 'map',
        title: 'B author map',
        access: 'private',
        data: mapData(layer),
      });
      if (!map)
        return verdict([`the author could not save a map with a shared layer: ${short(res)}`]);
      await api(app.baseUrl, admin, 'DELETE', `/api/items/${layer}/share`, share);
      const again = await api(app.baseUrl, author, 'PATCH', `/api/items/${map}`, {
        title: 'B author map, edited',
        data: { ...mapData(layer), zoom: 4 },
      });
      if (again.status !== 200) p.push(`saving the stored layer again: ${short(again)}`);
      const added = await api(app.baseUrl, author, 'PATCH', `/api/items/${map}`, {
        data: {
          layers: [
            ...(mapData(layer).layers as unknown[]),
            mapLayer('l2', fx.A.items['data_layer:org']!),
          ],
        },
      });
      if (added.status !== 400)
        p.push(`adding another org's layer: expected 400, got ${short(added)}`);
      const unknown = await api(app.baseUrl, author, 'PATCH', `/api/items/${map}`, {
        data: {
          layers: [
            ...(mapData(layer).layers as unknown[]),
            mapLayer('l2', '00000000-0000-4000-8000-00000000abcd'),
          ],
        },
      });
      // An id that does not exist gets the same answer.
      const body = (r: ApiResult): string => {
        const { requestId: _r, ...rest } = (r.body ?? {}) as Record<string, unknown>;
        void _r;
        return JSON.stringify(rest).replace(/[0-9a-f-]{36}/g, '<id>');
      };
      if (unknown.status !== added.status || body(unknown) !== body(added)) {
        p.push(`an unknown id answered differently: ${short(unknown)} / ${short(added)}`);
      }
      return verdict(p);
    },
  },
  {
    name: "map extent refresh and housekeeping recompute agree on another org's public layer",
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const { id } = await createItem(state, fx.B.users.admin, {
        type: 'map',
        title: 'B map with A public layer',
        access: 'private',
        data: mapData(fx.B.items['data_layer:public']!),
      });
      if (!id) return verdict(['B could not save its map']);
      // A's own recompute stores its layers' extents first.
      await api(app.baseUrl, fx.A.users.admin, 'POST', '/api/admin/housekeeping/recompute-extents');
      // Saving the map's data runs the background extent refresh.
      const save = await api(app.baseUrl, fx.B.users.admin, 'PATCH', `/api/items/${id}`, {
        data: mapData(fx.A.items['data_layer:public']!),
      });
      if (save.status !== 200)
        return verdict([`B could not point its map at A's public layer: ${short(save)}`]);
      await sleep(1500);
      const refreshed = await bboxOf(state, fx.B.users.admin, id);
      if (!covers(refreshed, AREAS.A.public)) {
        return verdict([`the refresh did not use A's public layer: [${refreshed.join(',')}]`]);
      }
      await api(app.baseUrl, fx.B.users.admin, 'POST', '/api/admin/housekeeping/recompute-extents');
      const recomputed = (
        (
          (await api(app.baseUrl, fx.B.users.admin, 'GET', `/api/items/${id}`)).body as {
            bbox?: number[];
          }
        )?.bbox ?? []
      ).map(Number);
      return verdict(
        JSON.stringify(refreshed) === JSON.stringify(recomputed)
          ? []
          : [`refresh gave [${refreshed.join(',')}], recompute gave [${recomputed.join(',')}]`],
      );
    },
  },
  {
    name: 'a derived layer of another org reads as not found and cannot be used as a source',
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      for (const access of ['private', 'org'] as const) {
        const id = fx.A.items[`derived_layer:${access}`];
        if (!id) {
          p.push(`the ${access} derived layer fixture was not created`);
          continue;
        }
        for (const path of [
          `/api/items/${id}`,
          `/api/items/${id}/geojson`,
          `/api/items/${id}/dependencies`,
        ]) {
          const own = await api(app.baseUrl, fx.A.users.admin, 'GET', path);
          const other = await api(app.baseUrl, fx.B.users.admin, 'GET', path);
          if (own.status !== 200) p.push(`control ${path}: ${short(own)}`);
          if (other.status !== 404) p.push(`${path}: expected 404, got ${short(other)}`);
          const leaks = fx.A.secrets.filter((x) => other.text.includes(x) && x !== id);
          if (leaks.length) p.push(`${path} showed A's data: ${leaks.join(', ')}`);
        }
      }
      const source = fx.A.items['derived_layer:private'];
      if (source) {
        const { res } = await createItem(state, fx.B.users.admin, {
          type: 'derived_layer',
          title: "B layer from A's derived layer",
          access: 'private',
          data: {
            version: 1,
            source: { kind: 'derived_layer', itemId: source },
            pipeline: [{ tool: 'buffer', params: { mode: 'fixed', distance: 10, unit: 'meters' } }],
            featureLimit: 1000,
            outputSchema: [],
            bbox: [],
          },
        });
        if (res.status < 300) p.push(`B saved a derived layer on A's derived layer: ${res.status}`);
      }
      return verdict(p);
    },
  },
  {
    name: "expressions: layer names resolve inside the caller's org",
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      // A layer whose title only A uses, with A's marker in its rows.
      const { id } = await createItem(state, fx.A.users.admin, {
        type: 'data_layer',
        title: 'Only in A layer',
        access: 'private',
        data: {
          version: 3,
          layers: [
            {
              id: LAYER_ID,
              name: 'Sites',
              geometryType: 'point',
              fields: [{ name: 'note', type: 'string' }],
            },
          ],
        },
      });
      if (!id) return verdict(['A could not create its layer']);
      await api(
        app.baseUrl,
        fx.A.users.admin,
        'POST',
        `/api/items/${id}/layers/${LAYER_ID}/features`,
        {
          features: [
            {
              geometry: { type: 'Point', coordinates: [140, -35] },
              properties: { note: fx.A.secrets[0] },
            },
          ],
        },
      );
      const layer = fx.B.items['data_layer:private']!;
      const r = await api(
        app.baseUrl,
        fx.B.users.admin,
        'POST',
        `/api/items/${layer}/layers/${LAYER_ID}/expressions/evaluate`,
        {
          expressions: {
            sameTitle: "nearest(layer('Shared title data_layer private')).note",
            onlyA: "nearest(layer('Only in A layer')).note",
          },
        },
      );
      if (r.status !== 200 && r.status !== 201) p.push(`evaluate: ${short(r)}`);
      const leaks = fx.A.secrets.filter((x) => r.text.includes(x));
      if (leaks.length) p.push(`B's expression read A's rows: ${leaks.join(', ')}`);
      if (!r.text.includes(fx.B.secrets[0]!))
        p.push(`control: the same title did not find B's own layer: ${short(r)}`);
      return verdict(p);
    },
  },
  {
    name: "realtime: a ticket for one map cannot join another org's map room",
    modes: BOTH,
    async run(state) {
      const { app, fx } = state;
      const p: string[] = [];
      const mapA = fx.A.items['map:private']!;
      const mapB = fx.B.items['map:private']!;
      const ticketA = await ticketFor(state, fx.A.users.admin, mapA);
      const ticketB = await ticketFor(state, fx.B.users.admin, mapB);
      if (!ticketA || !ticketB) return verdict(['could not get tickets for own maps']);
      if ((await joinRoom(app.baseUrl, mapA, ticketB)) !== 'closed')
        p.push("B joined A's room with its own ticket");
      if ((await joinRoom(app.baseUrl, mapA, 'not-a-ticket')) !== 'closed')
        p.push("a made-up ticket joined A's room");
      if ((await joinRoom(app.baseUrl, mapA, ticketA)) !== 'joined')
        p.push('control: A could not join its own room');
      return verdict(p);
    },
  },
];

/** A refusal body with request ids and item ids blanked, for comparing two answers. */
function answerShape(r: ApiResult): string {
  const { requestId: _r, ...rest } = (r.body ?? {}) as Record<string, unknown>;
  void _r;
  return `${r.status} ${JSON.stringify(rest).replace(/[0-9a-f-]{36}/g, '<id>')}`;
}

/** An id that names no item. */
const UNKNOWN_ID = '00000000-0000-4000-8000-00000000abcd';

/** Minimal v3 data layer data with the fixtures' sublayer. */
const LAYER_DATA = {
  version: 3,
  layers: [
    {
      id: LAYER_ID,
      name: 'Sites',
      geometryType: 'point',
      fields: [{ name: 'note', type: 'string', label: 'Note', nullable: true }],
    },
  ],
};

/**
 * One item type and one reference field: how to write data that
 * refers to `ref`. `permission` is the share the author needs on the
 * target to set the reference at all.
 */
type ReferenceCase = {
  label: string;
  type: string;
  data(ref: string): Record<string, unknown>;
  permission?: 'view' | 'edit';
};

const REFERENCE_CASES: ReferenceCase[] = [
  { label: 'map clip boundary', type: 'map', data: (ref) => ({ layers: [], clipBoundaryId: ref }) },
  { label: 'map basemap', type: 'map', data: (ref) => ({ layers: [], basemap: ref }) },
  {
    label: 'map extent boundary',
    type: 'map',
    data: (ref) => ({ layers: [], defaultExtentBoundaryId: ref }),
  },
  { label: 'map geocoder', type: 'map', data: (ref) => ({ layers: [], geocoderId: ref }) },
  {
    label: 'map terrain',
    type: 'map',
    data: (ref) => ({ layers: [], terrain: { itemId: ref, tileUrl: '', stack: [{ itemId: ref, tileUrl: '' }] } }),
  },
  {
    label: 'derived layer source',
    type: 'derived_layer',
    data: (ref) => ({
      version: 1,
      source: { kind: 'data_layer', itemId: ref, layerKey: LAYER_ID },
      pipeline: [{ tool: 'buffer', params: { mode: 'fixed', distance: 100, unit: 'meters' } }],
      featureLimit: 1000,
      outputSchema: [],
      bbox: [],
    }),
  },
  {
    label: 'editor app map',
    type: 'web_app',
    data: (ref) => ({ template: 'editor', mapId: ref, targets: [] }),
  },
  {
    label: 'custom app map widget',
    type: 'web_app',
    data: (ref) => ({
      template: 'custom',
      config: {
        custom: {
          pages: [{ id: 'p1', title: 'Page', widgets: [{ id: 'w1', config: { kind: 'map', mapId: ref } }] }],
        },
      },
    }),
  },
  { label: 'folder child', type: 'folder', data: (ref) => ({ childItemIds: [ref] }) },
  { label: 'data collection map', type: 'data_collection', data: (ref) => ({ mapId: ref }) },
  {
    label: 'report template source',
    type: 'report_template',
    data: (ref) => ({ body: 'Report', sources: [{ itemId: ref, layerKey: LAYER_ID }] }),
  },
  {
    label: 'tile layer elevation',
    type: 'tile_layer',
    data: (ref) => ({ preferredElevationItemId: ref }),
  },
  {
    label: 'point cloud elevation',
    type: 'point_cloud',
    data: (ref) => ({ preferredElevationItemId: ref }),
  },
  {
    label: 'geocoder source layer',
    type: 'geocoding_service',
    data: (ref) => ({ sourceLayerId: ref }),
  },
  {
    label: 'form linked layer',
    type: 'form',
    permission: 'edit',
    data: (ref) => ({ schemaVersion: 1, questions: [], linkedLayerId: ref, linkedLayerKey: LAYER_ID }),
  },
  {
    label: 'tool target',
    type: 'tool',
    data: (ref) => ({ action: { kind: 'open-item', targetItemId: ref } }),
  },
  { label: 'print template map', type: 'print_template', data: (ref) => ({ defaultMapId: ref }) },
  {
    label: 'basemap composed map',
    type: 'basemap',
    data: (ref) => ({ version: 1, kind: 'composed-map', mapItemId: ref }),
  },
  {
    label: 'data layer pick list',
    type: 'data_layer',
    data: (ref) => ({
      version: 3,
      layers: [
        {
          id: LAYER_ID,
          name: 'Sites',
          geometryType: 'point',
          fields: [
            {
              name: 'kind',
              type: 'string',
              label: 'Kind',
              nullable: true,
              domain: { type: 'coded-value-ref', pickListItemId: ref },
            },
          ],
        },
      ],
    }),
  },
];

/**
 * For each reference an item can store: org B's author keeps a stored
 * reference after losing access to its target, cannot add org A's
 * private item, and gets the same answer for it as for an id that
 * does not exist.
 */
function referenceTopics(): Topic[] {
  return REFERENCE_CASES.map((c) => ({
    name: `references: ${c.label} keeps a stored reference and refuses adding another org's item`,
    modes: BOTH,
    async run(state: SuiteState): Promise<Verdict> {
      const { app, fx } = state;
      const p: string[] = [];
      const admin = fx.B.users.admin;
      const author = fx.B.users.contributor;
      const { res: made, id: target } = await createItem(state, admin, {
        type: 'data_layer',
        title: `B target for ${c.label}`,
        access: 'private',
        data: LAYER_DATA,
      });
      if (!target) return verdict([`B's admin could not create the target: ${short(made)}`]);
      const share = { principalType: 'user', principalId: author.id, permission: c.permission ?? 'view' };
      await api(app.baseUrl, admin, 'POST', `/api/items/${target}/share`, share);
      const { res, id } = await createItem(state, author, {
        type: c.type,
        title: `B ${c.label}`,
        access: 'private',
        data: c.data(target),
      });
      if (!id) return verdict([`control: the author could not save a readable reference: ${short(res)}`]);
      await api(app.baseUrl, admin, 'DELETE', `/api/items/${target}/share`, share);
      const stored = await api(app.baseUrl, author, 'GET', `/api/items/${id}`);
      const again = await api(app.baseUrl, author, 'PATCH', `/api/items/${id}`, {
        title: `B ${c.label}, edited`,
        data: (stored.body as { data?: unknown } | undefined)?.data ?? c.data(target),
      });
      if (again.status !== 200) p.push(`saving the stored reference again: ${short(again)}`);
      const other = fx.A.items['data_layer:private']!;
      const added = await api(app.baseUrl, author, 'PATCH', `/api/items/${id}`, {
        data: c.data(other),
      });
      if (added.status !== 400) p.push(`adding another org's item: expected 400, got ${short(added)}`);
      const unknown = await api(app.baseUrl, author, 'PATCH', `/api/items/${id}`, {
        data: c.data(UNKNOWN_ID),
      });
      if (answerShape(unknown) !== answerShape(added)) {
        p.push(`an unknown id answered differently: ${short(unknown)} / ${short(added)}`);
      }
      const leaks = fx.A.secrets.filter((x) => added.text.includes(x) && x !== other);
      if (leaks.length) p.push(`the refusal showed A's data: ${leaks.join(', ')}`);
      const created = await createItem(state, author, {
        type: c.type,
        title: `B ${c.label} with A's item`,
        access: 'private',
        data: c.data(other),
      });
      if (created.res.status !== 400)
        p.push(`creating with another org's item: expected 400, got ${short(created.res)}`);
      if (c.type === 'derived_layer') {
        // The author kept the recipe but can no longer read its source:
        // reads through it answer with nothing from the source.
        const fc = await api(app.baseUrl, author, 'GET', `/api/items/${id}/geojson`);
        if (fc.status === 200 && featureCount(fc) > 0)
          p.push(`the derived layer still served the unshared source: ${featureCount(fc)} features`);
        const row = await api(app.baseUrl, author, 'GET', `/api/items/${id}`);
        const bbox = (row.body as { bbox?: unknown[] } | undefined)?.bbox ?? [];
        if (bbox.length > 0) p.push(`the derived layer still showed the source extent: ${JSON.stringify(bbox)}`);
      }
      return verdict(p);
    },
  }));
}

/** Map "Save as" leaves out what the person saving cannot read and lists the ids. */
function mapSaveAsTopic(): Topic {
  return {
    name: "map save as leaves out another org's items and lists their ids",
    modes: BOTH,
    async run(state: SuiteState): Promise<Verdict> {
      const { app, fx } = state;
      const p: string[] = [];
      const author = fx.B.users.contributor;
      const source = fx.B.items['map:org'];
      const ownLayer = fx.B.items['data_layer:org'];
      const otherLayer = fx.A.items['data_layer:private']!;
      const otherBoundary = fx.A.items['geo_boundary:private'] ?? fx.A.items['map:private']!;
      if (!source || !ownLayer) return verdict(["B's org map or layer fixture was not created"]);
      const r = await api(app.baseUrl, author, 'POST', `/api/items/${source}/copy`, {
        title: 'B copy',
        includeMarkup: false,
        data: {
          layers: [mapLayer('mine', ownLayer), mapLayer('theirs', otherLayer)],
          clipBoundaryId: otherBoundary,
        },
      });
      if (r.status !== 201 && r.status !== 200) return verdict([`save as was refused: ${short(r)}`]);
      const body = r.body as { id?: string; omittedItemIds?: string[]; warnings?: string[] };
      const omitted = [...(body.omittedItemIds ?? [])].sort();
      const expected = [otherLayer, otherBoundary].sort();
      if (JSON.stringify(omitted) !== JSON.stringify(expected))
        p.push(`omittedItemIds: expected ${expected.join(', ')}, got ${omitted.join(', ')}`);
      if ((body.warnings ?? []).length !== expected.length)
        p.push(`expected one warning per left-out id, got ${JSON.stringify(body.warnings)}`);
      const leaks = fx.A.secrets.filter((x) => r.text.includes(x) && !expected.includes(x));
      if (leaks.length) p.push(`the answer showed A's data: ${leaks.join(', ')}`);
      if (body.id) {
        const copy = await api(app.baseUrl, author, 'GET', `/api/items/${body.id}`);
        const data = (copy.body as { data?: { layers?: Array<{ id: string }> } } | undefined)?.data;
        const text = JSON.stringify(data ?? {});
        for (const id of expected) if (text.includes(id)) p.push(`the copy still refers to ${id}`);
        if (!data?.layers?.some((l) => l.id === 'mine')) p.push('the readable layer was not kept');
      }
      return verdict(p);
    },
  };
}

TOPICS.push(...referenceTopics(), mapSaveAsTopic(), elevationHintTopic(), appTemplateTopic());

/**
 * A map layer's elevation hint is copied from its tile item, not chosen
 * by the author: a hint naming another org's private item is left out
 * of the saved layer instead of refusing the save.
 */
function elevationHintTopic(): Topic {
  return {
    name: "map layer elevation hint naming another org's item is left out, not refused",
    modes: BOTH,
    async run(state: SuiteState): Promise<Verdict> {
      const { app, fx } = state;
      const p: string[] = [];
      const author = fx.B.users.contributor;
      const hidden = fx.A.items['data_layer:private']!;
      const { res: made, id: tile } = await createItem(state, author, {
        type: 'tile_layer',
        title: 'B tile for the hint',
        access: 'private',
        data: {},
      });
      if (!tile) return verdict([`control: the author could not create a tile layer: ${short(made)}`]);
      const layer = (id: string) => ({
        id,
        name: 'Tiles',
        visible: true,
        source: { kind: 'tile', itemId: tile, tileUrl: '', preferredElevationItemId: hidden },
      });
      const hintOf = async (mapId: string): Promise<unknown[]> => {
        const r = await api(app.baseUrl, author, 'GET', `/api/items/${mapId}`);
        const layers = (r.body as { data?: { layers?: Array<{ source?: Record<string, unknown> }> } })
          ?.data?.layers;
        return (layers ?? []).map((l) => l.source?.preferredElevationItemId);
      };
      const { res, id: map } = await createItem(state, author, {
        type: 'map',
        title: 'B map with a tile layer',
        access: 'private',
        data: { layers: [layer('t1')] },
      });
      if (!map) return verdict([`creating the map was refused: ${short(res)}`]);
      if (res.text.includes(hidden)) p.push('the create answer kept the hint');
      if ((await hintOf(map)).some((h) => h !== undefined)) p.push('the saved layer kept the hint');
      const added = await api(app.baseUrl, author, 'PATCH', `/api/items/${map}`, {
        data: { layers: [layer('t1'), layer('t2')] },
      });
      if (added.status !== 200) p.push(`adding a second tile layer was refused: ${short(added)}`);
      if ((await hintOf(map)).some((h) => h !== undefined)) p.push('the updated layers kept the hint');
      return verdict(p);
    },
  };
}

/**
 * Creating an app from a saved template the person can read leaves out
 * the template's references they cannot read and lists the ids. The
 * same payload without the template id, or with an unreadable id that
 * is not in the template, is refused as on any create.
 */
function appTemplateTopic(): Topic {
  return {
    name: 'an app made from a saved template leaves out what the person cannot read',
    modes: BOTH,
    async run(state: SuiteState): Promise<Verdict> {
      const { app, fx } = state;
      const p: string[] = [];
      const admin = fx.B.users.admin;
      const author = fx.B.users.contributor;
      const { id: privateMap } = await createItem(state, admin, {
        type: 'map',
        title: "B admin's private map",
        access: 'private',
        data: { layers: [] },
      });
      const ownLayer = fx.B.items['data_layer:org'];
      if (!privateMap || !ownLayer) return verdict(['fixtures for the template were not created']);
      const blueprint = (mapId: string) => ({
        version: 5,
        mapId,
        pages: [{ id: 'p1', title: 'Page', widgets: [{ id: 'w1', config: { kind: 'map', mapId } }] }],
        targets: [{ dataLayerId: ownLayer, layerKey: LAYER_ID }],
      });
      const { res: tres, id: template } = await createItem(state, admin, {
        type: 'app_template',
        title: 'B template',
        access: 'org',
        data: blueprint(privateMap),
      });
      if (!template) return verdict([`B's admin could not save the template: ${short(tres)}`]);
      const appData = (mapId: string) => ({
        version: 1,
        template: 'custom',
        config: { template: 'custom', custom: blueprint(mapId) },
      });
      const made = await createItem(state, author, {
        type: 'web_app',
        title: 'B app from template',
        access: 'private',
        data: appData(privateMap),
        fromTemplateId: template,
      });
      const body = made.res.body as { omittedItemIds?: string[]; warnings?: string[] };
      if (!made.id) p.push(`creating from the template was refused: ${short(made.res)}`);
      else {
        if (JSON.stringify(body.omittedItemIds) !== JSON.stringify([privateMap]))
          p.push(`omittedItemIds: ${JSON.stringify(body.omittedItemIds)}`);
        if ((body.warnings ?? []).length !== 1) p.push(`warnings: ${JSON.stringify(body.warnings)}`);
        const saved = await api(app.baseUrl, author, 'GET', `/api/items/${made.id}`);
        const text = JSON.stringify((saved.body as { data?: unknown }).data ?? {});
        if (text.includes(privateMap)) p.push('the app still refers to the unreadable map');
        if (!text.includes(ownLayer)) p.push('the readable layer target was not kept');
      }
      const plain = await createItem(state, author, {
        type: 'web_app',
        title: 'B app without the template id',
        access: 'private',
        data: appData(privateMap),
      });
      if (plain.res.status !== 400)
        p.push(`without fromTemplateId: expected 400, got ${short(plain.res)}`);
      const other = fx.A.items['data_layer:private']!;
      const extra = await createItem(state, author, {
        type: 'web_app',
        title: 'B app with an id not in the template',
        access: 'private',
        data: { ...appData(privateMap), extra: { mapId: other } },
        fromTemplateId: template,
      });
      const unknown = await createItem(state, author, {
        type: 'web_app',
        title: 'B app with an unknown id',
        access: 'private',
        data: { ...appData(privateMap), extra: { mapId: UNKNOWN_ID } },
        fromTemplateId: template,
      });
      if (extra.res.status !== 400)
        p.push(`an unreadable id not in the template: expected 400, got ${short(extra.res)}`);
      if (answerShape(extra.res) !== answerShape(unknown.res))
        p.push(`an unknown id answered differently: ${short(unknown.res)} / ${short(extra.res)}`);
      const foreign = fx.A.items['app_template:org'] ?? fx.A.items['app_template:private'];
      if (foreign) {
        const r = await createItem(state, author, {
          type: 'web_app',
          title: "B app from A's template",
          access: 'private',
          data: appData(privateMap),
          fromTemplateId: foreign,
        });
        if (r.res.status !== 404) p.push(`another org's template: expected 404, got ${short(r.res)}`);
      }
      return verdict(p);
    },
  };
}

export function topicsFor(mode: TenancyMode): Array<[string, Topic]> {
  return [...TOPICS, ...STORAGE_TOPICS]
    .filter((t) => t.modes.includes(mode))
    .map((t) => [t.name, t]);
}
