// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ProbeRequestDto } from './service-probe.controller.js';

/**
 * The nested credential's own rules used to be skipped, so an unknown
 * kind went out as an anonymous probe instead of a 400.
 */
describe('ProbeRequestDto', () => {
  async function errorsFor(credential: unknown) {
    const dto = plainToInstance(ProbeRequestDto, {
      url: 'https://example.com/arcgis/rest/services',
      credential,
    });
    return (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).map(
      (e) => e.property,
    );
  }

  it('accepts a well formed credential', async () => {
    expect(await errorsFor({ kind: 'bearer', token: 'abc' })).toEqual([]);
  });

  it('rejects an unknown kind and a non-string token', async () => {
    expect(await errorsFor({ kind: 'x' })).toEqual(['credential']);
    expect(await errorsFor({ kind: 'bearer', token: 5 })).toEqual(['credential']);
  });
});
