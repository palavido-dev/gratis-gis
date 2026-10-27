// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { DrawingsPromoteController } from './drawings-promote.controller.js';

/**
 * Promote must stay signed-in only (R3-anonymous-markup). Anonymous
 * markup writes are @Public on the drawings controller; this
 * controller must NOT be, and must refuse a null user even if a
 * caller somehow bypasses the JWT guard.
 */
describe('DrawingsPromoteController', () => {
  it('is not marked @Public (anon callers get 401 from JwtAuthGuard)', () => {
    const classPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      DrawingsPromoteController,
    );
    expect(classPublic).toBeUndefined();
    const methodPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      DrawingsPromoteController.prototype.promote,
    );
    expect(methodPublic).toBeUndefined();
  });

  it('refuses a null user before calling the promote service', () => {
    const promoteSvc = { promote: jest.fn() };
    const ctrl = new DrawingsPromoteController(promoteSvc as never);
    expect(() =>
      ctrl.promote(
        null as never,
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        {},
      ),
    ).toThrow(BadRequestException);
    expect(promoteSvc.promote).not.toHaveBeenCalled();
  });
});
