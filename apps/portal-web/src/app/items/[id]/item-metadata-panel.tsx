// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { getItemTypeLabel } from '@gratis-gis/shared-types';
import type {
  DataLayerData,
  DataLayerSource,
  ItemType,
} from '@gratis-gis/shared-types';
import { CopyButton } from '@/components/ui/copy-button';

/**
 * The Metadata tab of the item detail page.
 *
 * Everything here used to live in a `<details>` disclosure above the
 * fold, which meant description and tags were one click away and the
 * license, the source format and the item's own identifier were
 * nowhere at all. They were readable only through the API. The panel
 * splits into prose on the left and a labelled DETAILS column on the
 * right, which is the shape every catalogue record in this space uses
 * and the shape people arrive expecting.
 *
 * Values are never invented. A field with nothing behind it renders
 * as a muted "Not recorded" rather than a plausible default, because
 * "CC-BY-4.0" appearing on an item nobody licensed is worse than a
 * blank.
 */

const FORMAT_LABELS: Record<DataLayerSource['format'], string> = {
  geojson: 'GeoJSON',
  geoparquet: 'GeoParquet',
  kml: 'KML',
  kmz: 'KMZ',
  shapefile: 'Shapefile',
  gdb: 'File geodatabase',
  xlsx: 'Excel workbook',
  csv: 'CSV',
  manual: 'Entered by hand',
  api: 'Loaded through the API',
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border px-3 py-2 first:border-t-0">
      <dt className="text-2xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm text-ink-1">{children}</dd>
    </div>
  );
}

function NotRecorded() {
  return <span className="text-muted">Not recorded</span>;
}

/** A copyable identifier: monospace value plus an icon-only copy button. */
function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <Row label={label}>
      <span className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink-1">
          {value}
        </code>
        <CopyButton value={value} iconOnly title={`Copy ${label}`} />
      </span>
    </Row>
  );
}

export function ItemMetadataPanel({
  itemId,
  itemType,
  description,
  tags,
  license,
  createdAt,
  updatedAt,
  ownerLabel,
  data,
}: {
  itemId: string;
  itemType: ItemType;
  description: string;
  tags: string[];
  license: string | null;
  createdAt: string;
  updatedAt: string;
  ownerLabel: string;
  /** Raw item.data. Only read for data_layer provenance / identifiers. */
  data: unknown;
}) {
  const dl =
    itemType === 'data_layer' ? (data as DataLayerData | null) : null;
  // Provenance is per-layer on v3 and item-level on v1/v2. Take the
  // first layer that recorded one: a v3 item can in principle mix
  // sources across layers, and when it does the per-layer Source tab
  // is the honest place to read them. This column answers "what kind
  // of thing is this", which the first source does adequately.
  const source: DataLayerSource | undefined =
    dl?.version === 3
      ? dl.layers.find((l) => l.source)?.source
      : (dl?.source ?? undefined);

  // Identifiers worth exposing. For v3 the storage identifier is the
  // engine scope, which is what an operator would actually query
  // (`SELECT ... FROM observation WHERE scope = '...'`). v3 layers do
  // NOT have per-layer tables; the `fs_<item>_<layer>` naming in the
  // older design notes was superseded by the observation log.
  const scopes: Array<{ label: string; value: string }> =
    dl?.version === 3
      ? dl.layers.map((l) => ({
          label: dl.layers.length === 1 ? 'Storage scope' : `Scope: ${l.label}`,
          value: `data_layer:${itemId}:${l.id}`,
        }))
      : dl?.version === 2
        ? [
            {
              label: 'Storage table',
              value: `fs_${itemId.replace(/-/g, '')}`,
            },
          ]
        : [];

  const licenseIsUrl = license ? /^https?:\/\//i.test(license) : false;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <section>
          <h3 className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
            Description
          </h3>
          {description && description.trim() ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-1">
              {description}
            </p>
          ) : (
            <p className="text-sm text-muted">
              No description yet. A sentence about what this is and where
              it came from is the difference between an item someone
              reuses and one they re-create.
            </p>
          )}
        </section>
        <section>
          <h3 className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
            Tags
          </h3>
          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/items?q=${encodeURIComponent(tag)}`}
                  className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent/40 hover:text-ink-1"
                >
                  {tag}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No tags.</p>
          )}
        </section>
      </div>

      <dl className="h-fit rounded-lg border border-border bg-surface-1 text-sm shadow-card">
        <Row label="Type">{getItemTypeLabel(itemType)}</Row>
        <Row label="Owner">{ownerLabel}</Row>
        <Row label="Created">
          {createdAt ? new Date(createdAt).toLocaleString() : <NotRecorded />}
        </Row>
        <Row label="Updated">
          {updatedAt ? new Date(updatedAt).toLocaleString() : <NotRecorded />}
        </Row>
        <Row label="License">
          {license ? (
            licenseIsUrl ? (
              <a
                href={license}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2"
              >
                {license}
              </a>
            ) : (
              license
            )
          ) : (
            <NotRecorded />
          )}
        </Row>
        {dl ? (
          <>
            <Row label="Source">
              {source?.fileName ? (
                source.fileName
              ) : source ? (
                FORMAT_LABELS[source.format]
              ) : (
                <NotRecorded />
              )}
            </Row>
            <Row label="Source format">
              {source ? FORMAT_LABELS[source.format] : <NotRecorded />}
            </Row>
            {source?.sourceSrs ? (
              <Row label="Original projection">{source.sourceSrs}</Row>
            ) : null}
          </>
        ) : null}
        <IdRow label="Item ID" value={itemId} />
        {scopes.map((s) => (
          <IdRow key={s.value} label={s.label} value={s.value} />
        ))}
      </dl>
    </div>
  );
}
