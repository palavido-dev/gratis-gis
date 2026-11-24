// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One rule for refusals by id: a row of another organization answers
// exactly like an id that does not exist (404, same message), so the
// answer does not tell the caller that the id is in use. Inside the
// caller's own organization a refusal keeps its 403 and its reason.

import { ForbiddenException, NotFoundException } from '@nestjs/common';

type OrgScoped = { orgId: string };

/**
 * The row when it exists and belongs to the caller's organization.
 * A missing row and a row of another organization both throw the same
 * NotFoundException.
 */
export function inCallerOrgOrNotFound<T extends OrgScoped>(
  row: T | null | undefined,
  caller: OrgScoped,
  notFoundMessage: string,
): T {
  if (!row || row.orgId !== caller.orgId) throw new NotFoundException(notFoundMessage);
  return row;
}

/**
 * Refuse access to a row that exists. A row of another organization
 * answers not found; a row of the caller's own organization answers
 * forbidden with the reason.
 */
export function refuseAccess(
  caller: OrgScoped,
  row: OrgScoped,
  notFoundMessage: string,
  forbiddenMessage: string,
): never {
  if (row.orgId !== caller.orgId) throw new NotFoundException(notFoundMessage);
  throw new ForbiddenException(forbiddenMessage);
}
