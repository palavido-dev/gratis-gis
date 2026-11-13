// SPDX-License-Identifier: AGPL-3.0-or-later
import { ITEM_TYPES } from '@gratis-gis/shared-types';
import {
  isLegacyServiceTypeParam,
  wizardTypeFromParam,
} from './wizard-type-param';

describe('wizardTypeFromParam', () => {
  const types = ITEM_TYPES as readonly string[];

  it('sends the deprecated service types to the Connected service flow', () => {
    for (const legacy of ['arcgis_service', 'wms_service', 'wfs_service']) {
      expect(wizardTypeFromParam(legacy, types)).toBe('service');
      expect(isLegacyServiceTypeParam(legacy)).toBe(true);
    }
  });

  it('keeps known types and sentinels, drops unknown values', () => {
    expect(wizardTypeFromParam('map', types)).toBe('map');
    expect(wizardTypeFromParam('custom', types)).toBe('custom');
    expect(wizardTypeFromParam('viewer', types)).toBe('viewer');
    expect(wizardTypeFromParam('nope', types)).toBeNull();
    expect(wizardTypeFromParam(null, types)).toBeNull();
    expect(isLegacyServiceTypeParam('service')).toBe(false);
  });
});
