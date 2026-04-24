'use client';

import { useState } from 'react';
import { Braces, ChevronDown, ExternalLink, Table2 } from 'lucide-react';
import type {
  FeatureField,
  DataLayerData,
  DataLayerDataV1,
  DataLayerDataV2,
  DataLayerDataV3,
  DataLayerSublayer,
  FieldDomain,
} from '@gratis-gis/shared-types';

/**
 * Detail-page schema inspector. Reads the item's stored schema
 * (v1/v2 single-field-set or v3 per-layer) and renders a dense
 * field table: name, type, required, domain summary, storage
 * constraints. Also exposes a "Raw JSON" disclosure for power
 * users who want to see the underlying item.data blob. Read-only —
 * editing schemas happens in the wizard or detail-page builder;
 * this panel is the "what does this service ACTUALLY look like"
 * answer you reach for when debugging or writing client code.
 *
 * Runs on any data_layer item regardless of version; unknown
 * shapes render a minimal "schema unavailable" stub rather than
 * crashing.
 */
interface Props {
  data: DataLayerData | null | undefined;
}

export function DataLayerSchema({ data }: Props) {
  const [open, setOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  if (!data) return null;

  const fieldSets: Array<{ label: string; layer?: DataLayerSublayer; fields: FeatureField[] }> =
    data.version === 3
      ? data.layers.map((l) => ({
          label: l.label || l.name || 'Layer',
          layer: l,
          fields: l.fields,
        }))
      : [
          {
            label: 'Fields',
            fields:
              (data as DataLayerDataV1 | DataLayerDataV2).fields ??
              [],
          },
        ];

  const totalFields = fieldSets.reduce((n, fs) => n + fs.fields.length, 0);

  return (
    <section className="mb-6 rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <Table2 className="h-3.5 w-3.5 text-muted" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Schema
          </span>
          <span className="text-xs text-muted">
            {fieldSets.length === 1
              ? `${totalFields} ${totalFields === 1 ? 'field' : 'fields'}`
              : `${fieldSets.length} layers, ${totalFields} fields total`}
          </span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border p-3">
          {fieldSets.map((fs, i) => (
            <SchemaTable
              key={i}
              heading={fs.label}
              fields={fs.fields}
              {...(fs.layer ? { layer: fs.layer } : {})}
            />
          ))}

          <details
            className="rounded border border-dashed border-border bg-surface-0"
            open={rawOpen}
            onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted hover:text-ink-1">
              <Braces className="h-3 w-3" />
              Raw JSON
              <span className="text-muted">
                (developer debug; the full item.data payload)
              </span>
            </summary>
            <pre className="max-h-96 overflow-auto border-t border-border bg-surface-1 p-2 font-mono text-[10.5px] leading-tight text-ink-1">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function SchemaTable({
  heading,
  layer,
  fields,
}: {
  heading: string;
  layer?: DataLayerSublayer;
  fields: FeatureField[];
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-0">{heading}</h3>
        {layer ? (
          <>
            <span className="text-[10px] uppercase tracking-wide text-muted">
              {layer.geometryType ?? 'table'}
            </span>
            {typeof layer.featureCount === 'number' ? (
              <span className="text-[11px] text-muted">
                Â· {layer.featureCount.toLocaleString()} feature
                {layer.featureCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {fields.length === 0 ? (
        <p className="rounded border border-dashed border-border bg-surface-0 px-3 py-4 text-center text-[11px] text-muted">
          No fields defined for this layer yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-[11px]">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="px-2 py-1 text-left font-medium">Type</th>
                <th className="px-2 py-1 text-left font-medium">Label</th>
                <th className="px-2 py-1 text-center font-medium">Req</th>
                <th className="px-2 py-1 text-left font-medium">Domain</th>
                <th className="px-2 py-1 text-left font-medium">Constraints</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.name} className="border-t border-border">
                  <td className="px-2 py-1 font-mono text-ink-0">{f.name}</td>
                  <td className="px-2 py-1 text-muted">{f.type}</td>
                  <td className="px-2 py-1 text-ink-1">
                    {f.label || <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-1 text-center text-muted">
                    {f.nullable ? '' : 'â—'}
                  </td>
                  <td className="px-2 py-1">
                    {f.domain ? <DomainCell domain={f.domain} /> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-1">
                    {f.storage ? <StorageCell storage={f.storage} /> : <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DomainCell({ domain }: { domain: FieldDomain }) {
  if (domain.type === 'coded-value') {
    return (
      <span className="text-ink-1">
        pick list Â·{' '}
        <span className="text-muted">
          {domain.values.length} value{domain.values.length === 1 ? '' : 's'}
        </span>
      </span>
    );
  }
  if (domain.type === 'coded-value-ref') {
    return (
      <span className="inline-flex items-center gap-1 text-ink-1">
        shared list Â·
        <a
          href={`/items/${domain.pickListItemId}`}
          className="inline-flex items-center gap-0.5 underline hover:text-ink-1"
        >
          open <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </span>
    );
  }
  if (domain.type === 'range') {
    return (
      <span className="text-ink-1">
        range Â· {domain.min} to {domain.max}
      </span>
    );
  }
  return <span className="text-muted">unknown</span>;
}

function StorageCell({
  storage,
}: {
  storage: NonNullable<FeatureField['storage']>;
}) {
  const parts: string[] = [];
  if (typeof storage.maxLength === 'number') {
    parts.push(`max ${storage.maxLength} chars`);
  }
  if (storage.numberKind) {
    parts.push(storage.numberKind);
  }
  if (
    typeof storage.precision === 'number' ||
    typeof storage.scale === 'number'
  ) {
    parts.push(`NUMERIC(${storage.precision ?? '?'}, ${storage.scale ?? '?'})`);
  }
  return parts.length > 0 ? (
    <span className="text-ink-1">{parts.join(' Â· ')}</span>
  ) : (
    <span className="text-muted">—</span>
  );
}
