// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit tests mock `globalThis.fetch`. safeFetch dials with node:http
 * through a pinned transport, so without this a mocked fetch is
 * bypassed and a test reaches the real network (and a real
 * certificate) for hosts like server.example.com.
 *
 * Route the transport through the global fetch, so whatever a test
 * assigns to `globalThis.fetch` is what safeFetch sees. URL checks,
 * DNS pinning decisions, and redirect validation still run in
 * safeFetch itself. Only the final dial is replaced.
 *
 * net-guards is required inside the hooks, not imported at the top.
 * This file runs before the spec, so a top-level import would load
 * net-guards before the spec's `jest.mock('node:dns/promises')` and
 * pin the real DNS lookup into it.
 *
 * The net-guards specs test the real transport, so they keep it.
 */
type Guards = typeof import('../common/net-guards.js');

const testPath = expect.getState().testPath ?? '';

if (!/[\\/]common[\\/]net-guards(\.live)?\.spec\.ts$/.test(testPath)) {
  const guards = (): Guards =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../common/net-guards.js') as Guards;
  beforeEach(() => {
    guards()._setSafeFetchTransportForTests((url, init) =>
      globalThis.fetch(url.toString(), init),
    );
  });
  afterEach(() => {
    guards()._setSafeFetchTransportForTests(null);
  });
}
