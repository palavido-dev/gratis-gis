// SPDX-License-Identifier: AGPL-3.0-or-later
import { inviteConflictKey } from './invite-conflict';
import { de } from './i18n/messages/de';
import { en } from './i18n/messages/en';
import { es } from './i18n/messages/es';
import { fr } from './i18n/messages/fr';
import { ptBR } from './i18n/messages/pt-BR';

describe('inviteConflictKey', () => {
  const body = (code?: string): string =>
    JSON.stringify({ statusCode: 409, error: 'Conflict', message: 'x', ...(code ? { code } : {}) });

  it('picks the message for each code', () => {
    expect(inviteConflictKey(body('already_member'))).toBe('adminUsers.invite.errAlreadyMember');
    expect(inviteConflictKey(body('address_unavailable'))).toBe(
      'adminUsers.invite.errAddressUnavailable',
    );
  });

  it('keeps the generic message without a known code, as before', () => {
    expect(inviteConflictKey(body())).toBe('adminUsers.invite.errDuplicate');
    expect(inviteConflictKey(body('something_else'))).toBe('adminUsers.invite.errDuplicate');
    expect(inviteConflictKey('')).toBe('adminUsers.invite.errDuplicate');
  });

  it('every locale has the words for each message', () => {
    for (const cat of [en, de, es, fr, ptBR]) {
      const invite = (cat as { adminUsers?: { invite?: Record<string, string> } }).adminUsers?.invite;
      for (const k of ['errAlreadyMember', 'errAddressUnavailable', 'errDuplicate']) {
        expect(typeof invite?.[k]).toBe('string');
        expect(invite?.[k]?.length).toBeGreaterThan(0);
      }
    }
  });
});
