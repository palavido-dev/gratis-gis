// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Specs for the shared form-schema validator, focused on the
// repeat-group walk (#344 family): the runtime stores repeat-group
// answers as an array of per-instance objects under
// response[groupId], and validate() must read them there, the same
// way pruneHidden does. They live here because portal-api hosts the
// monorepo's jest setup and maps @gratis-gis/form-schema at the
// package source; the forms service consumes this exact validator
// server-side.

import { validate } from '@gratis-gis/form-schema';
import type { FormSchema, Question } from '@gratis-gis/form-schema';

function makeForm(questions: Question[]): FormSchema {
  return {
    schemaVersion: 1,
    id: 'form-1',
    title: 'Test form',
    questions,
  };
}

const inspectionsGroup: Question = {
  id: 'grp_inspections',
  label: 'Inspections',
  type: 'group',
  repeat: {},
  children: [
    { id: 'inspector', label: 'Inspector', type: 'text', required: true },
    { id: 'severity', label: 'Severity', type: 'integer', min: 1, max: 5 },
  ],
};

describe('validate with repeat groups', () => {
  it('accepts a filled repeat instance whose required child is answered', () => {
    // The old flat walk looked for `inspector` at the TOP LEVEL of
    // the response, where it never exists for repeat children, so
    // every submission with a required repeat child was rejected
    // forever regardless of content.
    const form = makeForm([inspectionsGroup]);
    const result = validate(form, {
      grp_inspections: [{ inspector: 'Ana', severity: 3 }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an instance with an empty required child, identifying the instance', () => {
    const form = makeForm([inspectionsGroup]);
    const result = validate(form, {
      grp_inspections: [
        { inspector: 'Ana', severity: 3 },
        { severity: 2 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        questionId: 'grp_inspections[1].inspector',
        message: 'This field is required.',
      },
    ]);
  });

  it('runs per-type checks against instance values', () => {
    const form = makeForm([inspectionsGroup]);
    const result = validate(form, {
      grp_inspections: [{ inspector: 'Ana', severity: 9 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.questionId).toBe('grp_inspections[0].severity');
    expect(result.errors[0]?.message).toMatch(/at most 5/);
  });

  it('does not demand repeat children at top-level keys', () => {
    // Zero instances submitted: nothing to validate inside the
    // group, and the required child must NOT be requested at the
    // top level of the response.
    const form = makeForm([inspectionsGroup]);
    expect(validate(form, {}).ok).toBe(true);
    expect(validate(form, { grp_inspections: [] }).ok).toBe(true);
  });

  it('skips a repeat group hidden by visibleIf, mirroring pruneHidden', () => {
    const hiddenGroup: Question = {
      ...inspectionsGroup,
      visibleIf: {
        op: 'eq',
        left: { ref: 'mode' },
        right: { value: 'detailed' },
      },
    } as Question;
    const form = makeForm([
      { id: 'mode', label: 'Mode', type: 'text' },
      hiddenGroup,
    ]);
    // Group hidden: its instances are pruned before submit, so an
    // invalid instance must not block.
    const hidden = validate(form, {
      mode: 'simple',
      grp_inspections: [{}],
    });
    expect(hidden.ok).toBe(true);
    // Group visible: the same instance now fails.
    const visible = validate(form, {
      mode: 'detailed',
      grp_inspections: [{}],
    });
    expect(visible.ok).toBe(false);
  });

  it('evaluates child visibility against the instance object', () => {
    const group: Question = {
      id: 'grp',
      label: 'Grp',
      type: 'group',
      repeat: {},
      children: [
        { id: 'has_issue', label: 'Issue found?', type: 'boolean' },
        {
          id: 'issue_detail',
          label: 'Detail',
          type: 'text',
          required: true,
          visibleIf: {
            op: 'eq',
            left: { ref: 'has_issue' },
            right: { value: true },
          },
        },
      ],
    };
    const form = makeForm([group]);
    const result = validate(form, {
      grp: [
        { has_issue: false },
        { has_issue: true },
      ],
    });
    // Instance 0: detail hidden, not required. Instance 1: detail
    // visible and missing.
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        questionId: 'grp[1].issue_detail',
        message: 'This field is required.',
      },
    ]);
  });

  it('validates nested repeat groups against nested instance arrays', () => {
    const nested: Question = {
      id: 'outer',
      label: 'Outer',
      type: 'group',
      repeat: {},
      children: [
        { id: 'site', label: 'Site', type: 'text', required: true },
        {
          id: 'inner',
          label: 'Inner',
          type: 'group',
          repeat: {},
          children: [
            { id: 'reading', label: 'Reading', type: 'number', required: true },
          ],
        },
      ],
    };
    const form = makeForm([nested]);
    const result = validate(form, {
      outer: [
        {
          site: 'North',
          inner: [{ reading: 4.2 }, {}],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        questionId: 'outer[0].inner[1].reading',
        message: 'This field is required.',
      },
    ]);
  });

  it('still validates non-repeat group children at top-level keys', () => {
    const plainGroup: Question = {
      id: 'grp_contact',
      label: 'Contact',
      type: 'group',
      children: [
        { id: 'email', label: 'Email', type: 'email', required: true },
      ],
    };
    const form = makeForm([plainGroup]);
    const missing = validate(form, {});
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]?.questionId).toBe('email');
    const filled = validate(form, { email: 'ana@example.com' });
    expect(filled.ok).toBe(true);
  });
});
