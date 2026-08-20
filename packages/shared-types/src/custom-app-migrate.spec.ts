// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_CUSTOM_APP,
  migrateCustomAppData,
  type AppDataSource,
  type CustomAppData,
  type CustomWidget,
} from './custom-app';

/**
 * The v4 to v5 migration rewrites every existing app's layer
 * bindings on load. A mistake here is not an error: it is a chart
 * quietly answering about a different layer, on someone else's
 * dashboard, with nothing on screen to say so. So the cases below
 * pin behaviour rather than shape.
 */

const LAYER_A = { dataLayerId: 'item-a', layerKey: 'wells' };
const LAYER_B = { dataLayerId: 'item-b', layerKey: 'bridges' };
const LAYER_C = { dataLayerId: 'item-c', layerKey: 'storms' };

function widget(
  id: string,
  kind: CustomWidget['kind'],
  config: Record<string, unknown>,
): CustomWidget {
  return {
    id,
    kind,
    layout: { col: 1, row: 1, colSpan: 10, rowSpan: 10 },
    config: { kind, ...config } as CustomWidget['config'],
  };
}

function v4App(over: Partial<CustomAppData> = {}): CustomAppData {
  return {
    ...DEFAULT_CUSTOM_APP,
    version: 4,
    targets: [LAYER_A, LAYER_B, LAYER_C],
    pages: [{ id: 'home', title: 'Home', widgets: [] }],
    ...over,
  } as CustomAppData;
}

function sourceOf(app: CustomAppData, id: string | undefined): AppDataSource {
  const s = (app.sources ?? []).find((x) => x.id === id);
  if (!s) throw new Error(`no source ${String(id)}`);
  return s;
}

function cfg(w: CustomWidget): Record<string, unknown> {
  return w.config as unknown as Record<string, unknown>;
}

describe('migrateCustomAppData v4 -> v5', () => {
  it('turns every target into a source, in order, keeping the layer', () => {
    const out = migrateCustomAppData(v4App());
    expect(out.version).toBe(5);
    expect(out.sources).toHaveLength(3);
    expect(out.sources!.map((s) => s.layer)).toEqual([
      LAYER_A,
      LAYER_B,
      LAYER_C,
    ]);
    // Ids are distinct, which is the entire point of the change.
    expect(new Set(out.sources!.map((s) => s.id)).size).toBe(3);
  });

  it('binds each widget to the source its index pointed at', () => {
    const app = v4App({
      pages: [
        {
          id: 'home',
          title: 'Home',
          widgets: [
            widget('w1', 'chart', { targetIndex: 2, chartType: 'bar' }),
            widget('w2', 'indicator', { targetIndex: 0, aggregate: 'count' }),
          ],
        },
      ],
    });
    const out = migrateCustomAppData(app);
    const [w1, w2] = out.pages[0]!.widgets;
    expect(sourceOf(out, cfg(w1!).sourceId as string).layer).toEqual(LAYER_C);
    expect(sourceOf(out, cfg(w2!).sourceId as string).layer).toEqual(LAYER_A);
  });

  it('keeps targetIndex so an older client can still open the app', () => {
    const app = v4App({
      pages: [
        {
          id: 'home',
          title: 'Home',
          widgets: [widget('w1', 'chart', { targetIndex: 1 })],
        },
      ],
    });
    const out = migrateCustomAppData(app);
    expect(cfg(out.pages[0]!.widgets[0]!).targetIndex).toBe(1);
    expect(out.targets).toHaveLength(3);
  });

  it('leaves an out-of-range index unbound instead of clamping it', () => {
    // Clamping to source zero would make a widget that points at a
    // layer which is not there answer confidently about a different
    // one. Unbound renders an empty state that says so.
    const app = v4App({
      targets: [LAYER_A],
      pages: [
        {
          id: 'home',
          title: 'Home',
          widgets: [
            widget('w1', 'chart', { targetIndex: 7 }),
            widget('w2', 'chart', { targetIndex: -1 }),
          ],
        },
      ],
    });
    const out = migrateCustomAppData(app);
    expect(cfg(out.pages[0]!.widgets[0]!).sourceId).toBeUndefined();
    expect(cfg(out.pages[0]!.widgets[1]!).sourceId).toBeUndefined();
  });

  it('binds widgets nested in containers and tabs', () => {
    // A migration that only walked page-level widgets would leave a
    // chart inside a tab bound to nothing, which is exactly the case
    // a nested layout hides best.
    const inner = widget('inner', 'chart', { targetIndex: 1 });
    const tabbed = widget('tabbed', 'indicator', { targetIndex: 2 });
    const app = v4App({
      pages: [
        {
          id: 'home',
          title: 'Home',
          widgets: [
            widget('c1', 'container', { widgets: [inner] }),
            widget('t1', 'tabs', {
              tabs: [{ id: 't', label: 'T', widgets: [tabbed] }],
            }),
          ],
        },
      ],
    });
    const out = migrateCustomAppData(app);
    const container = cfg(out.pages[0]!.widgets[0]!) as {
      widgets: CustomWidget[];
    };
    expect(sourceOf(out, cfg(container.widgets[0]!).sourceId as string).layer)
      .toEqual(LAYER_B);
    const tabs = cfg(out.pages[0]!.widgets[1]!) as {
      tabs: Array<{ widgets: CustomWidget[] }>;
    };
    expect(sourceOf(out, cfg(tabs.tabs[0]!.widgets[0]!).sourceId as string).layer)
      .toEqual(LAYER_C);
  });

  it('moves the app-level follow-the-map setting onto every source', () => {
    const app = {
      ...v4App(),
      followMapWidgetId: 'w_map1',
    } as CustomAppData & { followMapWidgetId?: string };
    const out = migrateCustomAppData(app) as CustomAppData & {
      followMapWidgetId?: string;
    };
    expect(out.sources!.every((s) => s.followMapWidgetId === 'w_map1')).toBe(
      true,
    );
    // And the app-level field is gone: two mechanisms for one
    // question is how the per-widget mess started.
    expect(out.followMapWidgetId).toBeUndefined();
    expect('followMapWidgetId' in out).toBe(false);
  });

  it('is idempotent: migrating twice changes nothing', () => {
    const once = migrateCustomAppData(
      v4App({
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [widget('w1', 'chart', { targetIndex: 1 })],
          },
        ],
      }),
    );
    const twice = migrateCustomAppData(once);
    expect(twice).toEqual(once);
  });

  it('does not re-bind a widget that already names a source', () => {
    const already = migrateCustomAppData(
      v4App({
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [widget('w1', 'chart', { targetIndex: 0 })],
          },
        ],
      }),
    );
    // Author re-points the widget at a different source, and leaves
    // the stale index behind. The index must not win on next load.
    const repointed = {
      ...already,
      version: 4 as const,
      pages: [
        {
          ...already.pages[0]!,
          widgets: [
            {
              ...already.pages[0]!.widgets[0]!,
              config: {
                ...already.pages[0]!.widgets[0]!.config,
                sourceId: already.sources![2]!.id,
              } as CustomWidget['config'],
            },
          ],
        },
      ],
    };
    const out = migrateCustomAppData(repointed);
    expect(sourceOf(out, cfg(out.pages[0]!.widgets[0]!).sourceId as string).layer)
      .toEqual(LAYER_C);
  });

  it('handles an app with no targets at all', () => {
    const out = migrateCustomAppData(v4App({ targets: [] }));
    expect(out.version).toBe(5);
    expect(out.sources).toEqual([]);
  });

  it('carries a v1 app all the way through to sources', () => {
    // The ladder runs every step in order; a very old app must not
    // stop at v4 with no sources.
    const out = migrateCustomAppData(v4App({ version: 1 }));
    expect(out.version).toBe(5);
    expect(out.sources).toHaveLength(3);
  });
});
