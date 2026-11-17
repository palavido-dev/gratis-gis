// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who may delete an uploaded map icon.
 *
 * The uploader can remove their own icon. An org admin can remove
 * any icon in the org, which is the cleanup path when the uploader
 * has left. Another member of the org cannot.
 */
export function canDeleteMapIcon(
  user: { id: string; orgRole: string },
  row: { createdBy: string },
): boolean {
  return user.orgRole === 'admin' || user.id === row.createdBy;
}
