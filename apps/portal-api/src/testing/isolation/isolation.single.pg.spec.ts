// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The same two-organization probe with GRATIS_TENANCY unset, the
// self-hosted default. A self-hosted install serves one organization,
// so this documents how the API behaves today when a second org
// exists; known-gaps.ts lists where single mode differs from the multi
// mode rules. Org A is the oldest org: the install's own org and the
// operator.

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
  `org isolation over HTTP, single mode${TEST_URL ? '' : ' (skipped: TEST_DATABASE_URL is unset)'}`,
  () => {
    let state: SuiteState;

    beforeAll(async () => {
      state = await startSuite('single', TEST_URL!);
    });

    afterAll(async () => {
      await stopSuite(state, TEST_URL!, 'single');
    });

    it.each(probeOrder())('%s', async (key, entry) => {
      expectVerdict('single', key, await runCheck(state, key, entry));
    });
  },
);
