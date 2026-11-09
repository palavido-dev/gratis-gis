// SPDX-License-Identifier: AGPL-3.0-or-later
import { apiErrorMessage } from './api-error';

/**
 * Client fetch against the BFF that returns parsed JSON, or undefined
 * for an empty body (a 204 on DELETE). Sets a JSON content type when
 * there is a body and none was given. A failure throws the server's
 * sentence (apiErrorMessage) rather than the raw response text, which
 * could be a JSON wrapper or a proxy's HTML error page.
 */
export async function portalJson<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
