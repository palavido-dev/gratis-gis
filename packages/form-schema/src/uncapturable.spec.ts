// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_SIGNATURE_DATA_URL_CHARS,
  UNCAPTURABLE_QUESTION_TYPES,
  isUncapturable,
  validate,
  type FormSchema,
  type Question,
  type Response,
} from './index.js';

/**
 * A required question of a type nothing can capture used to make the
 * whole form permanently unsubmittable: the runtime drew a
 * placeholder, the respondent had no control to fill in, and the
 * validator went on demanding a value. There was no way out of that
 * from inside the form.
 *
 * These pin the escape hatch, and pin it narrowly: only the
 * requiredness is relaxed, and only for types on the shared list.
 */

function form(questions: Question[]): FormSchema {
  return { version: 1, title: 'T', questions } as unknown as FormSchema;
}

const q = (over: Partial<Question>): Question =>
  ({ id: 'q1', type: 'text', label: 'Q', ...over }) as Question;

describe('uncapturable question types', () => {
  it('names the five the runtime cannot collect', () => {
    expect([...UNCAPTURABLE_QUESTION_TYPES].sort()).toEqual([
      'area-buffer',
      'geoshape',
      'geotrace',
      'pick-feature',
      'route',
    ]);
  });

  it('does not include the spatial type that DOES work', () => {
    // geopoint has a real control; sweeping it in would silently stop
    // enforcing a requirement that can be satisfied.
    expect(isUncapturable('geopoint')).toBe(false);
    expect(isUncapturable('photo')).toBe(false);
    // The signature pad landed; a required signature is enforced.
    expect(isUncapturable('signature')).toBe(false);
  });

  it('a required uncapturable question does not block submission', () => {
    const r = validate(
      form([q({ id: 'trace', type: 'geotrace', required: true })]),
      {} as Response,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still enforces required on everything else', () => {
    const r = validate(
      form([q({ id: 'name', type: 'text', required: true })]),
      {} as Response,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/required/i);
  });

  it('relaxes only the empty case, not the whole question', () => {
    // A required geopoint is a control the respondent CAN satisfy, so
    // leaving it blank is still an error. This is the boundary the
    // fix must not cross.
    const r = validate(
      form([q({ id: 'where', type: 'geopoint', required: true })]),
      {} as Response,
    );
    expect(r.errors).toHaveLength(1);
  });

  it('leaves the rest of the form validating normally around it', () => {
    const r = validate(
      form([
        q({ id: 'trace', type: 'geotrace', required: true }),
        q({ id: 'name', type: 'text', required: true }),
      ]),
      { name: 'Ada' } as Response,
    );
    expect(r.errors).toEqual([]);
  });
});

describe('signature question', () => {
  const sig = () => form([q({ id: 'sig', type: 'signature', required: true })]);
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('a required signature left blank is an error', () => {
    const r = validate(sig(), {} as Response);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/required/i);
  });

  it('accepts a pending pad image', () => {
    const r = validate(sig(), {
      sig: [{ name: 'signature.png', mimeType: 'image/png', sizeBytes: 8, dataUrl: png }],
    } as unknown as Response);
    expect(r.errors).toEqual([]);
  });

  it('accepts an uploaded descriptor', () => {
    const r = validate(sig(), {
      sig: [
        { name: 'signature.png', mimeType: 'image/png', sizeBytes: 8, url: 'https://s/k', key: 'k' },
      ],
    } as unknown as Response);
    expect(r.errors).toEqual([]);
  });

  it('accepts a legacy bare data URL', () => {
    const r = validate(sig(), { sig: png } as unknown as Response);
    expect(r.errors).toEqual([]);
  });

  it('rejects more than one image and non-image values', () => {
    const two = validate(sig(), {
      sig: [
        { name: 'a.png', mimeType: 'image/png', sizeBytes: 8, dataUrl: png },
        { name: 'b.png', mimeType: 'image/png', sizeBytes: 8, dataUrl: png },
      ],
    } as unknown as Response);
    expect(two.errors).toHaveLength(1);
    const text = validate(sig(), { sig: 'my name' } as unknown as Response);
    expect(text.errors).toHaveLength(1);
  });

  const one = (a: Record<string, unknown>) =>
    validate(sig(), {
      sig: [{ name: 'signature.png', mimeType: 'image/png', sizeBytes: 8, ...a }],
    } as unknown as Response).errors.length;

  it('accepts only a PNG data URL', () => {
    expect(one({ dataUrl: png })).toBe(0);
    expect(one({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' })).toBe(1);
    expect(one({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBe(1);
    expect(
      validate(sig(), { sig: 'data:image/svg+xml,<svg/>' } as unknown as Response).errors,
    ).toHaveLength(1);
  });

  it('caps the data URL length', () => {
    const atCap = png + 'A'.repeat(MAX_SIGNATURE_DATA_URL_CHARS - png.length);
    expect(one({ dataUrl: atCap })).toBe(0);
    expect(one({ dataUrl: atCap + 'A' })).toBe(1);
  });

  it('accepts a storage path or an http(s) url, nothing else', () => {
    expect(one({ url: '/api/portal/storage/private/feature-attachment/k.png', key: 'k' })).toBe(0);
    expect(one({ url: 'http://localhost:9000/bucket/k.png', key: 'k' })).toBe(0);
    expect(one({ url: 'https://cdn.example.org/k.png', key: 'k' })).toBe(0);
    expect(one({ url: 'javascript:alert(1)', key: 'k' })).toBe(1);
    expect(one({ url: png, key: 'k' })).toBe(1);
    expect(one({ url: '/etc/passwd', key: 'k' })).toBe(1);
  });
});
