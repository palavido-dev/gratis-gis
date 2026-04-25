import { Calendar, FileInput, Globe } from 'lucide-react';
import type {
  DataLayerData,
  DataLayerDataV1,
  DataLayerDataV2,
  DataLayerDataV3,
  DataLayerSource,
} from '@gratis-gis/shared-types';

/**
 * Passive read-only panel that surfaces where the feature-service
 * data on this item came from. Answers three questions at a glance:
 *
 *   1. What file (and format, and size) was this built from?
 *   2. Who ran the import, and when?
 *   3. What spatial reference did the source use, and is the portal
 *      storing it (yes, always EPSG:4326) the same one?
 *
 * Renders the same shape for v1/v2 (top-level `source`) and v3 (a
 * source block per layer, one row each). Silently renders nothing
 * when the item has no source block recorded — that's the "legacy /
 * hand-seeded / not-recorded" path.
 */
interface Props {
  data: DataLayerData | null | undefined;
  /**
   * Optional map of userId -> display name. When present, the panel
   * uses it to render 'by Mateo Garcia' instead of the raw uuid
   * slice. Supplied from the server-rendered detail page.
   */
  userNames?: Record<string, string>;
}

export function DataLayerProvenance({ data, userNames }: Props) {
  if (!data) return null;

  if (data.version === 3) {
    return <V3Provenance data={data} userNames={userNames ?? {}} />;
  }

  const src = (data as DataLayerDataV1 | DataLayerDataV2).source;
  if (!src) return null;

  return (
    <section className="mb-6 rounded-md border border-border bg-surface-1 p-3">
      <header className="mb-2 flex items-center gap-2">
        <FileInput className="h-3.5 w-3.5 text-muted" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Source
        </h2>
      </header>
      <ProvenanceRow source={src} userNames={userNames ?? {}} />
      <SpatialRefRow source={src} />
    </section>
  );
}

function V3Provenance({
  data,
  userNames,
}: {
  data: DataLayerDataV3;
  userNames: Record<string, string>;
}) {
  const stamped = data.layers.filter((l) => !!l.source);
  if (stamped.length === 0) return null;

  return (
    <section className="mb-6 rounded-md border border-border bg-surface-1 p-3">
      <header className="mb-2 flex items-center gap-2">
        <FileInput className="h-3.5 w-3.5 text-muted" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Data sources
        </h2>
        <span className="text-[11px] text-muted">
          · {stamped.length} of {data.layers.length}{' '}
          {data.layers.length === 1 ? 'layer' : 'layers'} imported
        </span>
      </header>
      <ul className="space-y-2">
        {data.layers.map((layer) =>
          layer.source ? (
            <li
              key={layer.id}
              className="rounded border border-border bg-surface-0 p-2"
            >
              <p className="mb-1 text-xs font-medium text-ink-0">
                {layer.label}
                <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">
                  {layer.geometryType ?? 'table'}
                </span>
              </p>
              <ProvenanceRow source={layer.source} userNames={userNames} />
              <SpatialRefRow source={layer.source} />
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}

function ProvenanceRow({
  source,
  userNames,
}: {
  source: DataLayerSource;
  userNames: Record<string, string>;
}) {
  const importedBy =
    userNames[source.importedBy] ?? source.importedBy.slice(0, 8);
  const imported = new Date(source.importedAt);
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-1">
      <span>
        Imported from{' '}
        <span className="font-mono text-ink-0">
          {source.fileName ?? '(inline)'}
        </span>
      </span>
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
        {source.format}
      </span>
      {typeof source.sizeBytes === 'number' ? (
        <span className="text-muted">{formatSize(source.sizeBytes)}</span>
      ) : null}
      <span className="inline-flex items-center gap-1 text-muted">
        <Calendar className="h-3 w-3" />
        {imported.toLocaleDateString()} by {importedBy}
      </span>
      {source.note ? (
        <span className="text-[11px] text-muted italic">{source.note}</span>
      ) : null}
    </p>
  );
}

/**
 * Spatial reference line: storage is always EPSG:4326. When the
 * source SRS was non-4326 we note it + flag that reprojection
 * happened on ingest. Absent source SRS (legacy / GeoJSON with no
 * declared CRS) falls back to a simpler 'Storage: EPSG:4326' line.
 */
function SpatialRefRow({ source }: { source: DataLayerSource }) {
  const srs = source.sourceSrs;
  const wasReprojected = srs && srs !== 'EPSG:4326' && srs !== 'CRS:unknown';
  return (
    <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted">
      <Globe className="h-3 w-3" />
      Storage: EPSG:4326 (WGS 84)
      {wasReprojected ? (
        <span>
          · reprojected from{' '}
          <a
            href={`https://epsg.io/${srs.replace(/^EPSG:/, '')}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline hover:text-ink-1"
            title="Open the authority record for this CRS on epsg.io"
          >
            {srs}
          </a>{' '}
          on ingest
        </span>
      ) : srs === 'CRS:unknown' ? (
        <span>· source file had no declared CRS (assumed 4326)</span>
      ) : null}
    </p>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
