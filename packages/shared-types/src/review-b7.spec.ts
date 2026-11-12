// SPDX-License-Identifier: AGPL-3.0-or-later
import { stampBlueprint } from './app-templates';
import { applyAppTheme, applyAppThemeTokens } from './app-themes';
import type { CustomAppData } from './custom-app';

describe('stampBlueprint', () => {
  it('re-points a source that follows a map, and re-mints widgets inside tabs', () => {
    const app = {
      version: 5,
      sources: [{ id: 's', layer: { dataLayerId: 'd', layerKey: 'k' }, followMapWidgetId: 'w_map' }],
      pages: [
        {
          id: 'p',
          title: 'P',
          widgets: [
            { id: 'w_map', kind: 'map', layout: {}, config: { kind: 'map' } },
            {
              id: 'w_tabs',
              kind: 'tabs',
              layout: {},
              config: { kind: 'tabs', tabs: [{ id: 't1', widgets: [{ id: 'w_inner', kind: 'text', layout: {}, config: { kind: 'text' } }] }] },
            },
          ],
        },
      ],
    } as unknown as CustomAppData;
    const out = stampBlueprint(app);
    const widgets = out.pages[0]!.widgets as unknown as Array<{ id: string; config: { tabs?: Array<{ widgets: Array<{ id: string }> }> } }>;
    const mapId = widgets[0]!.id;
    expect(mapId).not.toBe('w_map');
    expect(out.sources![0]!.followMapWidgetId).toBe(mapId);
    expect(widgets[1]!.config.tabs![0]!.widgets[0]!.id).not.toBe('w_inner');
  });
});

describe('app theme tokens', () => {
  it('sets custom properties only', () => {
    const set: string[] = [];
    const el = { style: { setProperty: (k: string) => set.push(k) } };
    applyAppThemeTokens(el as never, { '--app-surface-0': '#fff', display: 'none', 'background-image': 'url(x)' });
    expect(set).toEqual(['--app-surface-0']);
  });

  it('does not resolve an inherited name as a preset', () => {
    const el = { style: { setProperty: () => undefined } };
    expect(() => applyAppTheme(el as never, 'constructor')).not.toThrow();
  });
});
