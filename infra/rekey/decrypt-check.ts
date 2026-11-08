// SPDX-License-Identifier: AGPL-3.0-or-later
import { decryptCredential } from '../../apps/portal-api/src/items/credential-cipher.ts';

const plain = decryptCredential(
  process.env.CHECK_CIPHERTEXT ?? '',
  process.env.CHECK_IV ?? '',
  process.env.CHECK_AAD ?? '',
);
if (plain === process.env.CHECK_EXPECT) {
  console.log('decrypt-ok');
} else {
  console.log('decrypt-mismatch');
  process.exit(1);
}
