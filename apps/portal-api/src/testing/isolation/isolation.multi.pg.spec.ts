// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two organizations on one install with GRATIS_TENANCY=multi: every
// route of the API, called by org B with org A's ids, must not read,
// list, change or reveal org A's data. See routes.ts and
// docs/testing/org-isolation.md.

import {
  expectVerdict,
  probeOrder,
  runCheck,
  startSuite,
  stopSuite,
  type SuiteState,
} from './suite.js';

const TEST_URL = process.env.TEST_DATABASE_URL;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the isolation suite would silently skip.',
  );
}

const d = TEST_URL ? describe : describe.skip;

jest.setTimeout(300_000);

d(
  `org isolation over HTTP, multi mode${TEST_URL ? '' : ' (skipped: TEST_DATABASE_URL is unset)'}`,
  () => {
    let state: SuiteState;

    beforeAll(async () => {
      state = await startSuite('multi', TEST_URL!);
    });

    afterAll(async () => {
      await stopSuite(state, TEST_URL!, 'multi');
    });

    it.each(probeOrder())('%s', async (key, entry) => {
      expectVerdict('multi', key, await runCheck(state, key, entry));
    });
  },
);
