// SPDX-License-Identifier: AGPL-3.0-or-later
import { pluralCaseFor, t } from './index';

describe('plural selection', () => {
  it('uses the rule of each locale', () => {
    expect(pluralCaseFor(0, 'en')).toBe('other');
    expect(pluralCaseFor(1, 'en')).toBe('one');
    // CLDR: French and Portuguese put zero in `one`.
    expect(pluralCaseFor(0, 'fr')).toBe('one');
    expect(pluralCaseFor(0, 'pt-BR')).toBe('one');
    expect(pluralCaseFor(0, 'de')).toBe('other');
    expect(pluralCaseFor(2, 'fr')).toBe('other');
  });

  it('renders zero in the singular for French', () => {
    expect(t('addToFolder.itemCount', { count: 0 }, 'fr')).toBe('0 élément');
    expect(t('addToFolder.itemCount', { count: 0 }, 'en')).toMatch(/^0 items?$/);
    expect(t('addToFolder.itemCount', { count: 0 }, 'en')).not.toBe('0 item');
  });
});
