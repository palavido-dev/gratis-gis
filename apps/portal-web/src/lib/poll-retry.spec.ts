// SPDX-License-Identifier: AGPL-3.0-or-later
import { shouldRetryPoll } from './poll-retry';

describe('shouldRetryPoll', () => {
  it('retries transient failures a few times', () => {
    expect(shouldRetryPoll(502, 1)).toBe(true);
    expect(shouldRetryPoll(null, 1)).toBe(true);
    expect(shouldRetryPoll(429, 1)).toBe(true);
    expect(shouldRetryPoll(502, 5)).toBe(false);
  });
  it('stops on a client error', () => {
    expect(shouldRetryPoll(404, 0)).toBe(false);
    expect(shouldRetryPoll(403, 0)).toBe(false);
  });
});
