// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `id` has the 8-4-4-4-12 hex shape Postgres accepts for a
 * uuid column. Looser than RFC 4122 on purpose: the database takes any
 * hex in that shape, and seeded ids are not always valid versions.
 */
export function isUuidShape(id: unknown): id is string {
  return typeof id === 'string' && UUID_SHAPE.test(id);
}

/**
 * Path parameter pipe for ids that name a row. Prisma throws on a
 * non-uuid string against a uuid column, and nothing maps that error,
 * so `GET /items/abc` used to be a 500 with a stack trace in the log.
 * A malformed id cannot name anything, so it is answered as not found.
 */
@Injectable()
export class UuidPathPipe implements PipeTransform<unknown, string> {
  constructor(private readonly message = 'Not found') {}

  transform(value: unknown): string {
    if (!isUuidShape(value)) throw new NotFoundException(this.message);
    return value;
  }
}
