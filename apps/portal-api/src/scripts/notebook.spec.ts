// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  looksLikeNotebook,
  stripNotebookOutputs,
} from '@gratis-gis/shared-types';

const notebook = (cells: unknown[]) =>
  JSON.stringify({ cells, nbformat: 4, nbformat_minor: 5, metadata: {} });

describe('notebook detection', () => {
  it('recognises a notebook by its shape, not its extension', () => {
    // There is no filename here. The source is a string on data_json,
    // so the content is the only thing that can tell us what it is.
    expect(looksLikeNotebook(notebook([]))).toBe(true);
  });

  it('does not mistake python for a notebook', () => {
    expect(looksLikeNotebook('print("hello")')).toBe(false);
    expect(looksLikeNotebook('')).toBe(false);
  });

  it('does not mistake arbitrary JSON for a notebook', () => {
    // A script that happens to start with a dict literal, or someone
    // pasting a GeoJSON file into the box by mistake.
    expect(looksLikeNotebook('{"type": "FeatureCollection"}')).toBe(false);
    expect(looksLikeNotebook('{"cells": []}')).toBe(false); // no nbformat
  });

  it('tolerates leading whitespace', () => {
    expect(looksLikeNotebook('\n\n  ' + notebook([]))).toBe(true);
  });
});

describe('stripNotebookOutputs', () => {
  it('empties code cell outputs and clears the execution count', () => {
    // Otherwise a notebook pasted after being run stores its plots on
    // the item, and every version snapshot keeps them forever.
    const withOutputs = notebook([
      {
        cell_type: 'code',
        source: ['print(1)'],
        execution_count: 7,
        outputs: [{ output_type: 'stream', text: ['1\n'] }],
      },
    ]);
    const stripped = JSON.parse(stripNotebookOutputs(withOutputs));
    expect(stripped.cells[0].outputs).toEqual([]);
    expect(stripped.cells[0].execution_count).toBeNull();
  });

  it('leaves markdown cells alone', () => {
    const src = notebook([
      { cell_type: 'markdown', source: ['# Title\n', 'Some prose.'] },
    ]);
    const stripped = JSON.parse(stripNotebookOutputs(src));
    expect(stripped.cells[0].source).toEqual(['# Title\n', 'Some prose.']);
  });

  it('keeps the code, which is the point', () => {
    const src = notebook([
      { cell_type: 'code', source: ['x = 1\n', 'print(x)'], outputs: [] },
    ]);
    const stripped = JSON.parse(stripNotebookOutputs(src));
    expect(stripped.cells[0].source).toEqual(['x = 1\n', 'print(x)']);
  });

  it('hands back anything unparseable untouched', () => {
    // The save path is the wrong place to tell someone their file is
    // broken. The run says so, with a real error.
    expect(stripNotebookOutputs('not json')).toBe('not json');
    expect(stripNotebookOutputs('{"nope": 1}')).toBe('{"nope": 1}');
  });
});
