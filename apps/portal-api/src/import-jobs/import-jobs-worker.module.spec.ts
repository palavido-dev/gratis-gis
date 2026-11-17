// SPDX-License-Identifier: AGPL-3.0-or-later
import { MODULE_METADATA } from '@nestjs/common/constants';

import { ResourceQuotaModule } from '../admin/resource-quota.module.js';
import { ImportJobsWorkerModule } from './import-jobs-worker.module.js';

/**
 * ImportJobsService takes ResourceQuotaService as @Optional(), so a
 * missing import does not fail the DI graph. It just resolves to
 * undefined in portal-worker, and the byte hold an import takes is never
 * released when the worker finishes or fails it.
 */
describe('ImportJobsWorkerModule', () => {
  it('provides ResourceQuotaService to the worker', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ImportJobsWorkerModule,
    ) as unknown[];
    expect(imports).toContain(ResourceQuotaModule);
  });
});
