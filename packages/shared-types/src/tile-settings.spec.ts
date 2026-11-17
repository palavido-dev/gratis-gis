// SPDX-License-Identifier: AGPL-3.0-or-later
import { tileFieldRefs } from './tile-settings';

type RefsInput = Parameters<typeof tileFieldRefs>[0];

function layer(over: Partial<RefsInput> = {}): RefsInput {
  return {
    renderer: { kind: 'simple' },
    labels: {
      enabled: false,
      template: '',
      size: 12,
      color: '#000',
      haloColor: '#fff',
      haloWidth: 1,
      placement: 'auto',
      anchor: 'center',
      offsetX: 0,
      offsetY: 0,
    },
    filter: null,
    popup: {
      enabled: true,
      mode: 'all',
      fields: [],
      titleTemplate: '',
      bodyTemplate: '',
    },
    style: {} as RefsInput['style'],
    ...over,
  };
}

describe('tileFieldRefs', () => {
  it('is empty for a plain layer with a click-only popup', () => {
    expect(tileFieldRefs(layer())).toEqual([]);
  });

  it('collects renderer, label, filter and extrusion fields, sorted', () => {
    const refs = tileFieldRefs(
      layer({
        renderer: { kind: 'unique-values', field: 'zone', categories: [] },
        labels: { ...layer().labels, enabled: true, template: '{{name}} ({{ pop | number }})' },
        filter: { combinator: 'all', clauses: [{ field: 'status', op: '==', value: 'x' }] },
        style: {
          polygon: { extrusion: { enabled: true, heightField: 'height' } },
        } as unknown as RefsInput['style'],
        scaledSymbology: [
          { style: {} as RefsInput['style'], renderer: { kind: 'class-breaks', field: 'area', stops: [], colors: [] } },
        ],
      }),
    );
    expect(refs).toEqual(['area', 'height', 'name', 'pop', 'status', 'zone']);
  });

  it('ignores a disabled label template', () => {
    const refs = tileFieldRefs(
      layer({ labels: { ...layer().labels, enabled: false, template: '{{name}}' } }),
    );
    expect(refs).toEqual([]);
  });

  it('asks for every field when the hover popup shows them all', () => {
    const refs = tileFieldRefs(
      layer({ popup: { ...layer().popup, showOnHover: true, mode: 'all' } }),
    );
    expect(refs).toEqual(['*']);
  });

  it('takes picked and template hover popup fields', () => {
    expect(
      tileFieldRefs(
        layer({ popup: { ...layer().popup, showOnHover: true, mode: 'picked', fields: ['b', 'a'] } }),
      ),
    ).toEqual(['a', 'b']);
    expect(
      tileFieldRefs(
        layer({
          popup: {
            ...layer().popup,
            showOnHover: true,
            mode: 'template',
            titleTemplate: '{{t}}',
            bodyTemplate: 'x {{b}}',
          },
        }),
      ),
    ).toEqual(['b', 't']);
  });
});
