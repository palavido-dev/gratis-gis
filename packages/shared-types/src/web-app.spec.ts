// SPDX-License-Identifier: AGPL-3.0-or-later
import { isWebAppTemplate } from './web-app';

describe('isWebAppTemplate', () => {
  it('accepts every template, so URL filters for viewer and custom survive a reload', () => {
    expect(['editor', 'viewer', 'custom'].every(isWebAppTemplate)).toBe(true);
    expect(isWebAppTemplate('dashboard')).toBe(false);
    expect(isWebAppTemplate(undefined)).toBe(false);
  });
});
