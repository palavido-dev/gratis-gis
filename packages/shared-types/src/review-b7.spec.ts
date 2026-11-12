// SPDX-License-Identifier: AGPL-3.0-or-later
import { stampBlueprint } from './app-templates';
import { applyAppTheme, applyAppThemeTokens } from './app-themes';
import type { CustomAppData } from './custom-app';
import { tilePrefetchPolicy as classifyTilePrefetch } from './tile-prefetch-policy';
import { isServiceData } from './service';
import { defaultThumbnailDesign, renderThumbnailSvg } from './thumbnail';

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


describe('review fixes: prefetch, service guard, thumbnails', () => {
  it('judges a protocol-relative template by its host', () => {
    const v = classifyTilePrefetch('//a.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(v.host).not.toBe('self');
    expect(classifyTilePrefetch('/api/tiles/{z}/{x}/{y}.pbf').host).toBe('self');
  });

  it('accepts a PostGIS live service', () => {
    expect(isServiceData({ version: 1, protocol: 'postgis_live' })).toBe(true);
  });

  it('renders a thumbnail from a design with non-string fields', () => {
    expect(() =>
      renderThumbnailSvg({
        title: 'T',
        typeLabel: 'Map',
        design: { background: 1, sidebar: null, sidebarLabelOverride: 5, logo: {} } as never,
        type: 'map',
      }),
    ).not.toThrow();
  });

  it('gives scripts their own palette', () => {
    expect(defaultThumbnailDesign('script' as never).sidebar).not.toBe('#475569');
  });
});
