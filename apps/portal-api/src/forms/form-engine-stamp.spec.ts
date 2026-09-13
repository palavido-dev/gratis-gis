// SPDX-License-Identifier: AGPL-3.0-or-later
import { ENGINE_VERSION } from '@gratis-gis/form-schema';

import { stampFormEngineVersion } from './form-engine-stamp.js';

describe('stampFormEngineVersion', () => {
  it('stamps the walked requirement, replacing whatever the client sent', () => {
    const out = stampFormEngineVersion({
      schemaVersion: 1,
      id: 'f',
      title: 'T',
      questions: [{ id: 'a', type: 'text', label: 'A' }],
      requiredEngineVersion: 999,
    }) as { requiredEngineVersion: number };
    expect(out.requiredEngineVersion).toBe(1);
  });

  it('marks a form using something this build does not know as newer', () => {
    const out = stampFormEngineVersion({
      schemaVersion: 1,
      id: 'f',
      title: 'T',
      questions: [{ id: 'a', type: 'hologram', label: 'A' }],
    }) as { requiredEngineVersion: number };
    expect(out.requiredEngineVersion).toBe(ENGINE_VERSION + 1);
  });

  it('leaves anything that is not form shaped alone', () => {
    expect(stampFormEngineVersion(null)).toBeNull();
    expect(stampFormEngineVersion('x')).toBe('x');
    expect(stampFormEngineVersion([1])).toEqual([1]);
    const noQuestions = { title: 'partial' };
    expect(stampFormEngineVersion(noQuestions)).toBe(noQuestions);
  });
});
