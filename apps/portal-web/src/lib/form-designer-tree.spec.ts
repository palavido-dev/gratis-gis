// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FormSchema, Question } from '@gratis-gis/form-schema';
import {
  collectIds,
  evaluate,
  isVisible,
} from '@gratis-gis/form-schema';
import {
  renameQuestionInForm,
  savedFormLink,
  shareRowInTree,
  uniquifyQuestionIds,
  withFormLink,
} from './form-designer-tree';

function text(id: string, extra: Partial<Question> = {}): Question {
  return { id, type: 'text', label: id, ...extra } as Question;
}

function group(id: string, children: Question[]): Question {
  return { id, type: 'group', label: id, children } as Question;
}

function form(questions: Question[]): FormSchema {
  return { id: 'f', title: 'F', schemaVersion: 1, questions } as FormSchema;
}

const ids = (qs: Question[]) => qs.map((q) => q.id);

describe('shareRowInTree', () => {
  it('moves an existing question next to the target instead of deleting it', () => {
    const f = form([text('a'), text('b'), text('c')]);
    const out = shareRowInTree(f, 'b', { kind: 'existing', id: 'a' });
    expect(ids(out.form.questions)).toEqual(['b', 'a', 'c']);
    expect(out.form.questions[0]!.layout).toEqual({ width: 'half' });
    expect(out.form.questions[1]!.layout).toEqual({ width: 'half' });
  });

  it('keeps a dragged group and its children', () => {
    const f = form([group('g', [text('g1'), text('g2')]), text('b')]);
    const out = shareRowInTree(f, 'b', { kind: 'existing', id: 'g' });
    expect(collectIds(out.form)).toEqual(new Set(['b', 'g', 'g1', 'g2']));
  });

  it('refuses a group dropped on its own child', () => {
    const f = form([group('g', [text('g1'), text('g2')]), text('b')]);
    const out = shareRowInTree(f, 'g1', { kind: 'existing', id: 'g' });
    expect(out.form).toBe(f);
  });

  it('starts a new full-width row when the target row is full, keeping the question', () => {
    const quarter = { layout: { width: 'quarter' as const } };
    const f = form([
      text('a', quarter),
      text('b', quarter),
      text('c', quarter),
      text('d', quarter),
      text('e'),
    ]);
    const out = shareRowInTree(f, 'b', { kind: 'existing', id: 'e' });
    expect(ids(out.form.questions)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(out.form.questions[2]!.layout).toBeUndefined();
  });

  it('lets the caller refuse the move and leaves the form as it was', () => {
    const f = form([text('a'), text('b')]);
    const out = shareRowInTree(f, 'b', { kind: 'existing', id: 'a' }, () => true);
    expect(out.refused).toBe(true);
    expect(out.form).toBe(f);
  });

  it('adds a new palette tile beside the target and names it for selection', () => {
    const f = form([text('a')]);
    const out = shareRowInTree(f, 'a', { kind: 'new', type: 'text' });
    expect(out.form.questions).toHaveLength(2);
    expect(out.selectId).toBe(out.form.questions[1]!.id);
  });
});

describe('renameQuestionInForm', () => {
  it('rewrites references in other questions', () => {
    const f = form([
      { id: 'species', type: 'select-one', label: 'S', choices: [{ value: 'oak', label: 'Oak' }] } as Question,
      text('notes', {
        visibleIf: { op: 'eq', left: { ref: 'species' }, right: { value: 'oak' } },
        calculate: { op: 'concat', operands: [{ call: 'upper', args: [{ ref: 'species' }] }] },
      }),
    ]);
    const out = renameQuestionInForm(f, 'species', 'tree_species');
    expect(out.questions[0]!.id).toBe('tree_species');
    expect(isVisible(out.questions[1]!, { tree_species: 'oak' })).toBe(true);
    expect(evaluate(out.questions[1]!.calculate, { tree_species: 'oak' })).toBe('OAK');
  });
});

describe('uniquifyQuestionIds', () => {
  it('gives repeated column names unique ids, inside groups too', () => {
    const f = form([text('name')]);
    const generated = [
      text('name', { bindTo: { column: 'name' } }),
      text('notes'),
      group('photos', [text('photo')]),
      group('inspections', [text('notes'), group('photos', [text('photo')])]),
    ];
    const out = uniquifyQuestionIds(f, generated);
    const all = [...collectIds(form([...f.questions, ...out]))];
    expect(all).toHaveLength(9);
    expect(out[0]!.id).toBe('name_2');
    expect(out[0]!.bindTo).toEqual({ column: 'name' });
  });
});

describe('form link helpers', () => {
  it('carries the link and the layer title onto an imported form', () => {
    const current = form([]);
    current.linkedLayerId = 'L1';
    current.linkedLayerKey = 'submissions';
    current.meta = { linkedLayerTitle: 'Layer' };
    const imported = form([text('a')]);
    const out = withFormLink(imported, current);
    expect(out.linkedLayerId).toBe('L1');
    expect(out.linkedLayerKey).toBe('submissions');
    expect(out.meta?.linkedLayerTitle).toBe('Layer');
    expect(ids(out.questions)).toEqual(['a']);
  });

  it('reads the link the server kept from the save response', () => {
    expect(
      savedFormLink({ data: { linkedLayerId: 'L1', linkedLayerKey: 'k' } }, {}),
    ).toEqual({ linkedLayerId: 'L1', linkedLayerKey: 'k' });
    expect(savedFormLink({ data: {} }, { linkedLayerId: 'L1' })).toEqual({});
    expect(savedFormLink(null, { linkedLayerId: 'L1' })).toEqual({ linkedLayerId: 'L1' });
  });
});
