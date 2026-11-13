// SPDX-License-Identifier: AGPL-3.0-or-later
import { SetMetadata } from '@nestjs/common';

export const PRINT_READABLE_KEY = 'printReadable';

/**
 * Mark a GET handler as one the server-side print may call with a
 * print read credential (see print-read-credential.ts). The handler
 * must read layer data for the item in its `:id` route param and must
 * check that item against the caller with ItemsService.get, which runs
 * as the user who asked for the print. Keep this list short: every
 * handler marked here is reachable by a print job.
 *
 * `path`, when given, further limits the request path. The service
 * proxy uses it so a print can run a layer query and nothing else
 * the upstream service offers.
 */
export const PrintReadable = (path?: RegExp) =>
  SetMetadata(PRINT_READABLE_KEY, path ?? true);
