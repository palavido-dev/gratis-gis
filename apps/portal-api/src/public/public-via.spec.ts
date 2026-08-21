// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PublicController } from './public.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ParsedVia } from '../data-layer/aggregate-params.js';

/**
 * The anonymous relate check.
 *
 * A relate reads a SECOND layer the request never named in its path.
 * On the authenticated controller that layer goes through the same
 * read assertion as the child. On the public mirror there is no user
 * to assert against, so the rule is narrower: the parent has to be
 * public in its own right.
 *
 * This is the check that goes missing. It was absent from the
 * aggregate mirror for a release, where `via` parsed cleanly and was
 * then dropped, so the endpoint answered 200 with numbers for the
 * WHOLE child layer while the caller believed they were scoped. The
 * tile mirror now takes a relate too, and both go through the one
 * method these cases pin.
 */
describe('PublicController.resolvePublicVia', () => {
  const PARENT_ID = '11111111-1111-7111-8111-111111111111';
  const publicParent = {
    id: PARENT_ID,
    data: {
      version: 3,
      layers: [
        {
          id: 'sites',
          label: 'Sites',
          geometryType: 'Point',
          fields: [{ name: 'KEY' }, { name: 'OVER' }],
        },
      ],
    },
    publicGeoBoundaryId: null,
  };

  const via = (over: Partial<ParsedVia> = {}): ParsedVia =>
    ({
      myField: 'SITE',
      parentField: 'KEY',
      parentItemId: PARENT_ID,
      parentLayerId: 'sites',
      ...over,
    }) as ParsedVia;

  function make(row: unknown) {
    const findFirst = jest.fn().mockResolvedValue(row);
    const controller = new PublicController(
      { item: { findFirst } } as unknown as PrismaService,
      // The relate check never reaches the features service; passing
      // a bare object rather than a stub is the assertion that it
      // must not.
      {} as never,
    ) as unknown as {
      resolvePublicVia(v: ParsedVia | undefined): Promise<unknown>;
    };
    return { controller, findFirst };
  }

  it('resolves a relate to a public parent', async () => {
    const { controller } = make(publicParent);
    await expect(controller.resolvePublicVia(via())).resolves.toMatchObject({
      myField: 'SITE',
      parentField: 'KEY',
      parentItemId: PARENT_ID,
      parentLayerId: 'sites',
    });
  });

  it('requires the parent item to be public', async () => {
    const { controller, findFirst } = make(publicParent);
    await controller.resolvePublicVia(via());
    // The gate is in the WHERE clause, so assert on the query rather
    // than on the result: a mirror that looked the item up without
    // `access: 'public'` would return the same shape here and leak a
    // private layer.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PARENT_ID,
          type: 'data_layer',
          access: 'public',
          deletedAt: null,
        }),
      }),
    );
  });

  it('404s when the parent is not public, or does not exist', async () => {
    const { controller } = make(null);
    await expect(controller.resolvePublicVia(via())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s on a parent id that is not even uuid-shaped', async () => {
    const { controller, findFirst } = make(publicParent);
    await expect(
      controller.resolvePublicVia(via({ parentItemId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('404s when the named layer is not in the parent schema', async () => {
    const { controller } = make(publicParent);
    await expect(
      controller.resolvePublicVia(via({ parentLayerId: 'nope' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a parent field the parent layer does not declare', async () => {
    // Otherwise the relate becomes a probe: ask about a column, read
    // the difference in the answer.
    const { controller } = make(publicParent);
    await expect(
      controller.resolvePublicVia(via({ parentField: 'SECRET' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an undeclared field inside the parent predicate too', async () => {
    const { controller } = make(publicParent);
    await expect(
      controller.resolvePublicVia(
        via({
          parentWhere: {
            combinator: 'all',
            clauses: [{ field: 'SECRET', op: '==', value: 'x' }],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('carries a declared parent predicate through', async () => {
    const { controller } = make(publicParent);
    const parentWhere = {
      combinator: 'all' as const,
      clauses: [{ field: 'OVER', op: '==' as const, value: 'yes' }],
    };
    await expect(
      controller.resolvePublicVia(via({ parentWhere })),
    ).resolves.toMatchObject({ parentWhere });
  });

  it('is a no-op with no relate, and costs no query', async () => {
    const { controller, findFirst } = make(publicParent);
    await expect(controller.resolvePublicVia(undefined)).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
