// SPDX-License-Identifier: AGPL-3.0-or-later
// One-click regex presets for the form designer's Pattern question.
// Each pattern is what the runtime anchors with ^...$, and each
// sample must match it (see regex-presets.spec.ts).

export type RegexPresetId =
  | 'email'
  | 'url'
  | 'usPhone'
  | 'e164Phone'
  | 'usZip'
  | 'caPostal'
  | 'ukPostcode'
  | 'isoDate'
  | 'time24h'
  | 'lettersOnly'
  | 'alphanumeric'
  | 'digitsOnly'
  | 'positiveInt'
  | 'decimal'
  | 'uuid'
  | 'hexColor';

export const REGEX_PRESET_DEFS: Array<{
  id: RegexPresetId;
  pattern: string;
  flags?: string;
  sample: string;
}> = [
  {
    id: 'email',
    pattern: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
    sample: 'me@example.com',
  },
  {
    id: 'url',
    pattern: 'https?://[^\\s/$.?#].[^\\s]*',
    sample: 'https://example.com/path?x=1',
  },
  {
    id: 'usPhone',
    pattern: '\\+?1?[\\s.-]?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}',
    sample: '(555) 867-5309',
  },
  {
    id: 'e164Phone',
    pattern: '\\+?\\d{7,15}',
    sample: '+14155552671',
  },
  {
    id: 'usZip',
    pattern: '\\d{5}(-\\d{4})?',
    sample: '94110-1234',
  },
  {
    id: 'caPostal',
    pattern: '[A-Za-z]\\d[A-Za-z][\\s-]?\\d[A-Za-z]\\d',
    flags: 'i',
    sample: 'K1A 0B1',
  },
  {
    id: 'ukPostcode',
    pattern: '[A-Za-z]{1,2}\\d[A-Za-z\\d]?\\s*\\d[A-Za-z]{2}',
    flags: 'i',
    sample: 'SW1A 1AA',
  },
  {
    id: 'isoDate',
    pattern: '\\d{4}-\\d{2}-\\d{2}',
    sample: '2026-04-28',
  },
  {
    id: 'time24h',
    // The hour alternation needs its group. Without it the anchored
    // pattern meant "00 to 19" or "20:00 to 23:59", so 14:30 failed.
    pattern: '([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?',
    sample: '14:30',
  },
  {
    id: 'lettersOnly',
    pattern: '[A-Za-z\\s]+',
    sample: 'Maria Sanchez',
  },
  {
    id: 'alphanumeric',
    pattern: '[A-Za-z0-9]+',
    sample: 'GIS2026Alpha',
  },
  {
    id: 'digitsOnly',
    pattern: '\\d+',
    sample: '40291',
  },
  {
    id: 'positiveInt',
    pattern: '[1-9]\\d*',
    sample: '12345',
  },
  {
    id: 'decimal',
    pattern: '-?\\d+(\\.\\d+)?',
    sample: '-3.14',
  },
  {
    id: 'uuid',
    pattern:
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    sample: '550e8400-e29b-41d4-a716-446655440000',
  },
  {
    id: 'hexColor',
    pattern: '#?([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})',
    sample: '#1a73e8',
  },
];
