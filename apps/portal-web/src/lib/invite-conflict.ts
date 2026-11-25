// SPDX-License-Identifier: AGPL-3.0-or-later
import { errorBodyCode } from './api-error';

/**
 * The invite dialog message for a 409 answer, chosen by the body's
 * code. An answer without a known code keeps the generic message.
 */
export function inviteConflictKey(
  body: string,
):
  | 'adminUsers.invite.errAlreadyMember'
  | 'adminUsers.invite.errAddressUnavailable'
  | 'adminUsers.invite.errDuplicate' {
  switch (errorBodyCode(body)) {
    case 'already_member':
      return 'adminUsers.invite.errAlreadyMember';
    case 'address_unavailable':
      return 'adminUsers.invite.errAddressUnavailable';
    default:
      return 'adminUsers.invite.errDuplicate';
  }
}
