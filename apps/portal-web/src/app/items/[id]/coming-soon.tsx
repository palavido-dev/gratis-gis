import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';

interface PillarInfo {
  label: string;
  blurb: string;
  /** Path to the design doc in the repo (used for the "read the plan" link). */
  doc: string;
}

/**
 * Marketing-adjacent copy for each pillar we haven't built yet. The
 * blurb should answer "what will this let me do" in one sentence,
 * because a user who lands on this page wanted to do something
 * specific and we owe them enough context to decide whether to wait
 * or pick a different tool for now.
 */
const PILLARS: Partial<Record<ItemType, PillarInfo>> = {
  data_layer: {
    label: 'Data layer',
    blurb:
      'A shareable vector layer backed by PostGIS. Upload GeoJSON or shapefiles, tile them on demand, and share column by column.',
    doc: 'docs/data-model.md',
  },
  form: {
    label: 'Form',
    blurb:
      'Define a data collection form that runs both on desktop and offline on phones and tablets.',
    doc: 'docs/field-app.md',
  },
  form_submission_collection: {
    label: 'Form submissions',
    blurb: 'A queryable view of submissions for a form, shareable on its own.',
    doc: 'docs/field-app.md',
  },
  web_app: {
    label: 'Web app',
    blurb:
      'Compose maps, dashboards, and forms into a branded app you can share with anyone.',
    doc: 'docs/app-builder.md',
  },
  report_template: {
    label: 'Report template',
    blurb:
      'Design a document template that renders form submissions or feature rows into PDF, Word, and HTML.',
    doc: 'docs/reporting.md',
  },
  dashboard: {
    label: 'Dashboard',
    blurb:
      'Live panels powered by your feature services: charts, counters, maps, filters.',
    doc: 'docs/app-builder.md',
  },
  notebook: {
    label: 'Notebook',
    blurb:
      'A hosted Jupyter notebook wired to the portal: read your items, write to feature services, share results.',
    doc: 'docs/notebooks.md',
  },
  tool: {
    label: 'Tool',
    blurb:
      'A reusable unit of work, visually wired from inputs to outputs. Think ETL, but built in the browser.',
    doc: 'docs/tool-builder.md',
  },
  widget_package: {
    label: 'Widget package',
    blurb:
      'Bundle custom widgets that show up in the app builder and dashboards.',
    doc: 'docs/app-builder.md',
  },
  layer_package: {
    label: 'Layer package',
    blurb:
      'Offline-ready bundle of basemap + operational layers for the field app.',
    doc: 'docs/field-app.md',
  },
  file: {
    label: 'File',
    blurb: 'Any uploaded file that should live alongside your content.',
    doc: 'docs/data-model.md',
  },
};

interface Props {
  type: ItemType;
  data: unknown;
}

/**
 * Placeholder surface for item types whose dedicated editor has not
 * shipped yet. Gives the user a clear explanation of what the type
 * will eventually do and exposes the raw data payload so nothing is
 * hidden while the pillar is being built.
 */
export function ComingSoon({ type, data }: Props) {
  const pillar = PILLARS[type];
  const label = pillar?.label ?? type;
  const blurb =
    pillar?.blurb ??
    'This item type does not have a dedicated editor yet. The raw data is shown below so you can still inspect it.';

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="flex items-start gap-3 border-b border-border bg-surface-2 p-4">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-ink-0">
            {label} &mdash; coming soon
          </h3>
          <p className="mt-1 text-sm text-muted">{blurb}</p>
          {pillar?.doc ? (
            <a
              href={`https://github.com/palavido-dev/gratis-gis/blob/main/${pillar.doc}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              Read the design
              <ArrowUpRight className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      </div>
      <div className="p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Raw data
        </h4>
        <pre className="overflow-x-auto rounded-md border border-border bg-surface-0 p-3 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}