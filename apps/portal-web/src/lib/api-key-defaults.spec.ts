// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NEW_API_KEY_DEFAULTS } from './api-key-defaults';

describe('new API key defaults', () => {
  it('start read only with a bounded expiry', () => {
    expect(NEW_API_KEY_DEFAULTS.readOnly).toBe(true);
    expect(NEW_API_KEY_DEFAULTS.expiryDays).toBe(90);
  });

  it('are what the API keys form uses', () => {
    const form = readFileSync(
      join(__dirname, '../app/settings/api-keys/api-keys-manager.tsx'),
      'utf8',
    );
    expect(form).toContain('useState<boolean>(NEW_API_KEY_DEFAULTS.readOnly)');
  });
});
