// SPDX-License-Identifier: AGPL-3.0-or-later
import {
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
  it('names the six the runtime cannot collect', () => {
    expect([...UNCAPTURABLE_QUESTION_TYPES].sort()).toEqual([
      'area-buffer',
      'geoshape',
      'geotrace',
      'pick-feature',
      'route',
      'signature',
    ]);
  });

  it('does not include the spatial type that DOES work', () => {
    // geopoint has a real control; sweeping it in would silently stop
    // enforcing a requirement that can be satisfied.
    expect(isUncapturable('geopoint')).toBe(false);
    expect(isUncapturable('photo')).toBe(false);
  });

  it('a required uncapturable question does not block submission', () => {
    const r = validate(
      form([q({ id: 'sig', type: 'signature', required: true })]),
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
        q({ id: 'sig', type: 'signature', required: true }),
        q({ id: 'name', type: 'text', required: true }),
      ]),
      { name: 'Ada' } as Response,
    );
    expect(r.errors).toEqual([]);
  });
});
