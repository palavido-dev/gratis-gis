// SPDX-License-Identifier: AGPL-3.0-or-later
import { SetMetadata } from '@nestjs/common';

export const PRINT_READABLE_KEY = 'printReadable';

/** Where a print read credential is accepted on one handler. */
export interface PrintReadableRule {
  /** The one method allowed. GET, or POST for a read that takes a body. */
  method: 'GET' | 'POST';
  /** Route param that holds the item id the credential must name. */
  idParam: string;
  /** When set, the full request path must match it too. */
  path?: RegExp;
}

/**
 * Mark a handler as one the server-side print may call with a print
 * read credential (see print-read-credential.ts). The handler must
 * only read layer data for the item in its id route param and must
 * check that item against the caller, which runs as the user who
 * asked for the print. Keep this list short: every handler marked
 * here is reachable by a print job.
 *
 * `path` limits the request path further. The service proxy uses it
 * so a print can run a layer query and nothing else the upstream
 * service offers. `method: 'POST'` is only for a read that takes its
 * query in the body (postgis-live features); it never marks a write.
 */
export const PrintReadable = (rule: Partial<PrintReadableRule> = {}) =>
  SetMetadata(PRINT_READABLE_KEY, {
    method: rule.method ?? 'GET',
    idParam: rule.idParam ?? 'id',
    ...(rule.path ? { path: rule.path } : {}),
  } satisfies PrintReadableRule);
