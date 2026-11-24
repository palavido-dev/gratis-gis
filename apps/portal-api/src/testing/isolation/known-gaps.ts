// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Routes that do not yet meet their isolation check, per tenancy mode.
// The suite expects each of these to fail. When a fix makes one pass,
// the suite fails until the entry is removed, so this list only
// shrinks. Each entry names the area of work that owns the fix.

import type { TenancyMode } from '../../common/tenancy.js';

export type KnownGap = {
  modes: TenancyMode[];
  /** The area of work that owns the fix. */
  area: string;
  /** One line: what is wrong, in neutral words. */
  note: string;
};

export const KNOWN_GAPS: Record<string, KnownGap> = {};
