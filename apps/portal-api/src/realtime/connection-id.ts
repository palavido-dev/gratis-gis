// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

/**
 * A new realtime connection id: random bytes and nothing else.
 *
 * Connection ids are sent to everyone else in the room, so they carry
 * no user id and nothing a reader could tie to a person. Who a member
 * is lives in the member's own fields (`userId`, `displayName`), which
 * the roster rules decide on.
 */
export function mintConnectionId(): string {
  return randomBytes(16).toString('base64url');
}
