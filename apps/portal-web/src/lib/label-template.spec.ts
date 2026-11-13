// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderLabelTemplate } from './label-template';

describe('renderLabelTemplate', () => {
  const props = { price: 1234, name: 'Smith & Sons', when: '2026-03-04T12:00:00Z' };

  it('applies formatters that take an argument', () => {
    const out = renderLabelTemplate('{{price | currency:USD}}', props, { locale: 'en' });
    expect(out).toBe('$1,234.00');
    expect(renderLabelTemplate('{{ when | date:short }}', props, { locale: 'en' })).toMatch(
      /3\/4\/26/,
    );
  });

  it('escapes only when asked', () => {
    expect(renderLabelTemplate('{{name}}', props)).toBe('Smith & Sons');
    expect(renderLabelTemplate('{{name}}', props, { escape: true })).toBe('Smith &amp; Sons');
  });

  it('keeps the plain formatters and blanks missing fields', () => {
    expect(renderLabelTemplate('{{name | upper}} {{nope}}', props)).toBe('SMITH & SONS ');
  });
});
