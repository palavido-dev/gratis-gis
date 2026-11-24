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

export function topicsFor(mode: TenancyMode): Array<[string, Topic]> {
  return TOPICS.filter((t) => t.modes.includes(mode)).map((t) => [t.name, t]);
}
