// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CalculateFieldDto } from './features.controller.js';

/**
 * scope and outputType are closed sets. A typo in scope used to skip
 * the selection branch and recalculate every row of the layer.
 */
describe('CalculateFieldDto', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(CalculateFieldDto, {
      expression: '1',
      outputName: 'x',
      outputType: 'number',
      scope: 'selection',
      ...body,
    });
    return (await validate(dto)).map((e) => e.property);
  }

  it('accepts the documented values', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ scope: 'all', outputType: 'boolean' })).toEqual([]);
  });

  it('rejects any other scope or output type', async () => {
    expect(await errorsFor({ scope: 'selected' })).toEqual(['scope']);
    expect(await errorsFor({ outputType: 'date' })).toEqual(['outputType']);
  });
});
