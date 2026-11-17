// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Container healthcheck target. Answers without calling the API.
 *
 * The healthcheck used to fetch `/`, which server-renders the public
 * landing page: an uncached read of every public item in the org,
 * every 30 seconds per container whatever the traffic, and a slow API
 * marked the web container unhealthy. This only says the Next server
 * is up and answering.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
