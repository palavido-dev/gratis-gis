// SPDX-License-Identifier: AGPL-3.0-or-later
import { Building2, Globe2, Lock, Scale } from 'lucide-react';
import type { ItemAccess, ItemType, LayerGeometryType } from '@gratis-gis/shared-types';
import { getItemTypeLabel } from '@gratis-gis/shared-types';
import { t } from '@/lib/i18n';

/**
 * Soft pill styling per type. Not `getItemTypeAccent`, which returns
 * text colours only, and not `getItemTypeTileClasses`, which returns a
 * solid tile: a small pill wants a tinted background with readable
 * text and neither helper provides that pairing. Moved here verbatim
 * from the detail page so there is still exactly one copy. Partial by
 * design, covering the types common enough to be worth a colour; the
 * rest fall through to the neutral surface. Raw palette colours ship
 * their `dark:` counterpart, per the design rules.
 */
const TYPE_PILL: Record<string, string> = {
  map: 'bg-success/15 text-success',
  data_layer: 'bg-info/15 text-info',
  arcgis_service: 'bg-cyan-100 dark:bg-cyan-950 text-cyan-800 dark:text-cyan-300',
  form: 'bg-violet-100 dark:bg-violet-950 text-violet-800 dark:text-violet-300',
  web_app: 'bg-warn/15 text-warn',
  report_template: 'bg-danger/15 text-danger',
  dashboard: 'bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-300',
  file: 'bg-surface-2 text-ink-1',
  tool: 'bg-teal-100 dark:bg-teal-950 text-teal-800 dark:text-teal-300',
  editor: 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300',
};

/**
 * The row of pills under an item's title: what it is, who can reach
 * it, what shape its data is, and how it is licensed.
 *
 * Deliberately NOT a "lifecycle" in the published/draft sense. We do
 * not have one: `access` already IS the catalog state, because public
 * is exactly what puts an item in the public catalog. Rendering a
 * separate "Published" pill would restate one fact as two, and the
 * two would eventually disagree.
 *
 * Server component. Every value is derived from props, so this costs
 * no client JS.
 */

const ACCESS_META: Record<
  ItemAccess,
  { icon: typeof Lock; labelKey: string; titleKey: string; className: string }
> = {
  private: {
    icon: Lock,
    labelKey: 'itemDetail.accessPrivate',
    titleKey: 'itemDetail.accessPrivateTitle',
    className: 'border-border bg-surface-2 text-muted',
  },
  org: {
    icon: Building2,
    labelKey: 'itemDetail.accessOrg',
    titleKey: 'itemDetail.accessOrgTitle',
    className: 'border-info/30 bg-info/10 text-info',
  },
  public: {
    icon: Globe2,
    labelKey: 'itemDetail.accessPublic',
    titleKey: 'itemDetail.accessPublicTitle',
    className: 'border-success/30 bg-success/10 text-success',
  },
};

const GEOMETRY_LABEL_KEY: Record<string, string> = {
  point: 'itemDetail.geometryPoint',
  line: 'itemDetail.geometryLine',
  polygon: 'itemDetail.geometryPolygon',
};

export function geometryLabel(
  geometryTypes: Array<LayerGeometryType | null | undefined>,
): string | null {
  const present = new Set(
    geometryTypes.filter((g): g is LayerGeometryType => Boolean(g)),
  );
  // An item whose every layer is attribute-only is a real, describable
  // thing (a related table), not a missing value, so it gets a label
  // rather than being skipped.
  if (present.size === 0) {
    return geometryTypes.length > 0 ? t('itemDetail.geometryNone') : null;
  }
  if (present.size > 1) return t('itemDetail.statMixed');
  const only = [...present][0] as string;
  const key = GEOMETRY_LABEL_KEY[only];
  return key ? t(key) : only;
}

interface Props {
  type: ItemType;
  access: ItemAccess;
  license?: string | null;
  /** One entry per layer. Empty for item types that have no layers.
   *  Explicitly `| undefined` because `exactOptionalPropertyTypes` is
   *  on, so an absent key and an undefined value are not the same
   *  thing and callers pass the latter. */
  geometryTypes?: Array<LayerGeometryType | null | undefined> | undefined;
}

export function ItemPills({ type, access, license, geometryTypes }: Props) {
  const meta = ACCESS_META[access];
  const AccessIcon = meta.icon;
  const geometry = geometryTypes ? geometryLabel(geometryTypes) : null;
  const trimmedLicense = license?.trim();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium tracking-wide ${TYPE_PILL[type] ?? 'bg-surface-2 text-ink-1'}`}
      >
        {getItemTypeLabel(type)}
      </span>
      <span
        title={t(meta.titleKey)}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${meta.className}`}
      >
        <AccessIcon className="h-3 w-3" />
        {t(meta.labelKey)}
      </span>
      {geometry ? (
        <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted">
          {geometry}
        </span>
      ) : null}
      {trimmedLicense ? (
        <span
          title={t('itemDetail.licenseTitle', { license: trimmedLicense })}
          className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted"
        >
          <Scale className="h-3 w-3 shrink-0" />
          <span className="truncate">{trimmedLicense}</span>
        </span>
      ) : null}
    </div>
  );
}
