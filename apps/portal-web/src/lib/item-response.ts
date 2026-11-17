// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `GET /api/portal/items/:id` returns the item itself, so its data is
 * `body.data`. The tile-layer editor read `body.item.data`, which is
 * always undefined, and its build-progress poll never updated. The
 * `item` wrapper is still accepted for callers that hand over a
 * wrapped body.
 */
export function itemDataFromBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { data?: unknown; item?: { data?: unknown } };
  return b.data ?? b.item?.data;
}
