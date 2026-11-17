// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a status poll should try again after a failed request.
 *
 * A job keeps running on the server while its progress poll fails, so
 * one 502 from a proxy restart must not end the progress display. A
 * network error or a 5xx is retried up to `maxConsecutive` times in a
 * row; a 4xx is an answer (the job is gone, access was withdrawn) and
 * stops the poll at once.
 */
export function shouldRetryPoll(
  status: number | null,
  consecutiveFailures: number,
  maxConsecutive = 5,
): boolean {
  if (consecutiveFailures >= maxConsecutive) return false;
  return status === null || status >= 500 || status === 429;
}
