// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';

interface PillarInfo {
  label: string;
  blurb: string;
  /** Path to the design doc in the repo (used for the "read the plan" link). */
  doc: string;
}

/**
 * Copy for item types that still have no editor. Shipped types
 * (data layers, forms, web apps, files, tools) have their own
 * detail pages and are intentionally absent here, so a fall-through
 * does not advertise them as upcoming.
 *
 * The blurb should answer "what will this let me do" in one sentence,
 * because a user who lands on this page wanted to do something
 * specific and we owe them enough context to decide whether to wait
 * or pick a different tool for now.
 */
const PILLARS: Partial<Record<ItemType, PillarInfo>> = {
  form_submission_collection: {
    label: 'Form submissions',
    blurb:
      'A standalone shareable view of one form\'s submissions. Today those rows live on the form\'s Responses tab.',
    doc: 'docs/field-app.md',
  },
  report_template: {
    label: 'Report template',
    blurb:
      'A document layout that would render form submissions or feature rows to PDF, Word, and HTML. Not built. Paper layouts for the Print tool are print templates, a different item.',
    doc: 'docs/reporting.md',
  },
  // `dashboard` deliberately has no entry any more. Dashboards
  // shipped, but as a starting layout for a custom web app rather
  // than a type of their own, so nothing creates this type and the
  // branch below tells the handful of legacy rows what to do instead
  // of promising a dedicated editor that will never arrive.
  // `tool` is also absent: the recipe editor is the detail page.
  // The node-graph canvas in docs/tool-builder.md is still unbuilt,
  // but that is a missing surface on a shipped item, not this page.
  widget_package: {
    label: 'Widget package',
    blurb:
      'A bundle of custom widgets for the app builder. Not built. The builder already ships its built-in widget set.',
    doc: 'docs/app-builder.md',
  },
  layer_package: {
    label: 'Layer package',
    blurb:
      'An offline bundle of a basemap plus operational layers for the field app. Not built. The field PWA downloads deployments directly.',
    doc: 'docs/field-app.md',
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
  // Legacy dashboard rows get a different answer from every other
  // type here: their feature is not pending, it is built somewhere
  // else. Only the old create form could make one, and only before
  // dashboards landed as a web-app layout, so this is a small
  // population that deserves a pointer rather than a placeholder.
  if (type === 'dashboard') {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="flex items-start gap-3 border-b border-border bg-surface-2 p-4">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-ink-0">
              Dashboards are now web apps
            </h3>
            <p className="mt-1 text-sm text-muted">
              Dashboard widgets (indicators, charts, tables, maps) are
              part of the web app builder, so a dashboard is a web app
              that starts from a dashboard layout and can grow into
              anything else you need. This item was created before
              that, and there is no editor for it.
            </p>
            <p className="mt-2 text-sm text-muted">
              Create a new web app and pick the{' '}
              <strong>KPI Dashboard</strong> or{' '}
              <strong>Operations Board</strong> template, then delete
              this item once you have moved anything you need out of
              the data below.
            </p>
            <Link
              href="/items/new?type=web_app"
              className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              Create a web app
              <ArrowUpRight className="h-3 w-3" />
            </Link>
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
            {label}: coming soon
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