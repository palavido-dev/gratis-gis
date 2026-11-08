// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recoveryMaintenanceFileActive } from './maintenance-mode.service.js';

describe('recovery maintenance file', () => {
  it('is active only while the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-maint-'));
    const file = join(dir, 'maintenance');
    expect(recoveryMaintenanceFileActive(undefined)).toBe(false);
    expect(recoveryMaintenanceFileActive(file)).toBe(false);
    writeFileSync(file, '{"maintenance":true}\n');
    expect(recoveryMaintenanceFileActive(file)).toBe(true);
    rmSync(dir, { recursive: true });
    expect(recoveryMaintenanceFileActive(file)).toBe(false);
  });
});
