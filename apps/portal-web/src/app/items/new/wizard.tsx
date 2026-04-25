'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  ExternalLink,
  FileText,
  FlaskConical,
  Folder as FolderIcon,
  Globe,
  Globe2,
  LayoutDashboard,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  Map as MapIcon,
  Notebook,
  Plug,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type {
  ArcgisServiceData,
  DataLayerDataV3,
  ISODateString,
  Item,
  ItemAccess,
  ItemType,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_BASEMAP,
  DEFAULT_DATA_LAYER_V3,
  DEFAULT_GEO_BOUNDARY,
  DEFAULT_PICK_LIST,
  DEFAULT_MAP,
  DEFAULT_WMS_SERVICE,
  DEFAULT_WFS_SERVICE,
  DEFAULT_FOLDER,
} from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';
import {
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';
import { DataLayerBuilder } from './data-layer-builder';
import { MetadataXmlImporter } from './metadata-xml-importer';

/**
 * Two-step "Create a new item" wizard:
 *   1. Pick a type.
 *   2. Fill in metadata + type-specific inputs on one screen.
 *
 * Step 2 is the only place that hits the API. For arcgis_service, the
 * service URL is probed inline and the probe result is baked into the
 * item's `data` at creation time so the detail page lands ready-to-use
 * instead of jumping to a #configure-arcgis anchor.
 */

type Step = 'pick' | 'details';

interface TypeOption {
  value: ItemType;
  label: string;
  desc: string;
  Icon: LucideIcon;
}

// Ordered most-common first. The grid layout handles responsive columns.
const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'map',
    label: 'Map',
    desc: 'A basemap with overlay layers and styling.',
    Icon: MapIcon,
  },
  {
    value: 'data_layer',
    label: 'Data layer',
    desc: 'A shareable vector layer backed by PostGIS.',
    Icon: Layers,
  },
  {
    value: 'arcgis_service',
    label: 'ArcGIS service',
    desc: 'Live pointer at a MapServer or FeatureServer.',
    Icon: Plug,
  },
  {
    value: 'wms_service',
    label: 'WMS service',
    desc: 'Live pointer at a WMS GetMap endpoint.',
    Icon: Plug,
  },
  {
    value: 'wfs_service',
    label: 'WFS service',
    desc: 'Live pointer at a WFS feature service.',
    Icon: Plug,
  },
  {
    value: 'pick_list',
    label: 'Pick list',
    desc: 'Shared list of codes + labels referenced by fields, forms, and filters.',
    Icon: ListChecks,
  },
  {
    value: 'geo_boundary',
    label: 'Boundary',
    desc: 'A named region (polygon) reused across shares, maps, and filters.',
    Icon: MapIcon,
  },
  {
    value: 'basemap',
    label: 'Basemap',
    desc: 'A reusable background layer (style URL, tile template, or WMS) for maps.',
    Icon: Globe,
  },
  {
    value: 'folder',
    label: 'Folder',
    desc: 'A curated grouping of items. Sharing a folder shares the arrangement; per-item access still applies.',
    Icon: FolderIcon,
  },
  {
    value: 'form',
    label: 'Form',
    desc: 'A collection form for fieldwork or survey data.',
    Icon: FileText,
  },
  {
    value: 'dashboard',
    label: 'Dashboard',
    desc: 'Live panels showing feature data.',
    Icon: LayoutDashboard,
  },
  {
    value: 'web_app',
    label: 'Web app',
    desc: 'A configurable app built from widgets.',
    Icon: Sparkles,
  },
  {
    value: 'report_template',
    label: 'Report template',
    desc: 'A document template that renders data.',
    Icon: FileText,
  },
  {
    value: 'notebook',
    label: 'Notebook',
    desc: 'A Jupyter notebook hosted in the portal.',
    Icon: Notebook,
  },
  {
    value: 'file',
    label: 'File',
    desc: 'Any uploaded file (PDF, image, zip, etc.).',
    Icon: FileText,
  },
];

const ACCESS_OPTIONS: Array<{
  value: ItemAccess;
  label: string;
  desc: string;
  Icon: LucideIcon;
}> = [
  {
    value: 'private',
    label: 'Private',
    desc: 'Only you and people you share with.',
    Icon: Lock,
  },
  {
    value: 'org',
    label: 'Your organization',
    desc: 'Everyone with a login in your org.',
    Icon: Building2,
  },
  {
    value: 'public',
    label: 'Public',
    desc: 'Anyone on the internet.',
    Icon: Globe2,
  },
];

export function NewItemWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('pick');
  const [type, setType] = useState<ItemType | null>(null);

  // Metadata persists across back/forward between steps so the user
  // doesn't lose typed input when they pop back to change type.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [access, setAccess] = useState<ItemAccess>('private');
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  // ArcGIS-specific state. Probe result is staged until Create fires.
  // `userEditedTitle` guards us from clobbering a title the user typed
  // by hand when the probe comes back with a service name.
  const [arcgisUrlDraft, setArcgisUrlDraft] = useState('');
  const [arcgisProbing, setArcgisProbing] = useState(false);
  const [arcgisProbeResult, setArcgisProbeResult] =
    useState<ArcgisServiceDescription | null>(null);
  const [arcgisDefaultLayerId, setArcgisDefaultLayerId] = useState<
    number | null
  >(null);
  // Which layers the user wants to include in this item. Default on
  // probe is 'all layers selected' so the most common case ('I want
  // the whole service') is zero clicks. User can deselect the few
  // they don't want before hitting Create.
  const [arcgisSelectedLayerIds, setArcgisSelectedLayerIds] = useState<
    Set<number>
  >(new Set());
  const arcgisAbortRef = useRef<AbortController | null>(null);
  const userEditedTitleRef = useRef(false);
  const userEditedDescRef = useRef(false);

  // Feature-service builder state. Stays in v3 shape from the start so
  // the POST body can be sent as-is.
  const [featureServiceData, setDataLayerData] =
    useState<DataLayerDataV3>(DEFAULT_DATA_LAYER_V3);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pickType = useCallback((t: ItemType) => {
    setType(t);
    setStep('details');
    setError(null);
  }, []);

  const backToPicker = useCallback(() => {
    setStep('pick');
    setError(null);
  }, []);

  const runArcgisProbe = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const desc = await probeService(raw, controller.signal);
      if (controller.signal.aborted) return;
      setArcgisProbeResult(desc);
      // Auto-fill title/description from the service only if the user
      // hasn't typed anything of their own - never clobber user input.
      if (!userEditedTitleRef.current && !title.trim() && desc.name) {
        setTitle(desc.name);
      }
      if (
        !userEditedDescRef.current &&
        !description.trim() &&
        desc.description
      ) {
        setDescription(desc.description);
      }
      // Pre-pick a sensible default sublayer: first one with geometry,
      // or the first layer if everything is attribute-only.
      const firstGeom = desc.layers.find((l) => l.geometryType);
      const pick = firstGeom?.id ?? desc.layers[0]?.id ?? null;
      setArcgisDefaultLayerId(pick);
      // Default selection on probe is 'everything' so the common
      // 'pull the whole service' case is zero clicks. The user can
      // uncheck layers they don't want before clicking Create.
      setArcgisSelectedLayerIds(new Set(desc.layers.map((l) => l.id)));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [arcgisUrlDraft, title, description]);

  async function submit() {
    if (!type) return;
    setError(null);
    if (title.trim().length === 0) {
      setError('Title is required.');
      return;
    }

    // For arcgis_service we require a successful probe so the item
    // lands fully configured. Everything else uses its default scaffold.
    let data: unknown;
    if (type === 'arcgis_service') {
      if (!arcgisProbeResult) {
        setError(
          'Probe the ArcGIS service URL before creating the item so the layer list is captured.',
        );
        return;
      }
      // Validate: selection must be non-empty. A zero-layer item
      // would be a dead reference nobody can use.
      if (arcgisSelectedLayerIds.size === 0) {
        setError(
          'Select at least one layer to include in this item. All layers are selected by default after probe.',
        );
        return;
      }
      // Default layer must be one of the selected layers - otherwise
      // a map consuming this item would land on a layer the item
      // claims not to own.
      const effectiveDefault =
        arcgisDefaultLayerId !== null &&
        arcgisSelectedLayerIds.has(arcgisDefaultLayerId)
          ? arcgisDefaultLayerId
          : (Array.from(arcgisSelectedLayerIds)[0] ?? null);
      const staged: ArcgisServiceData = {
        ...DEFAULT_ARCGIS_SERVICE,
        url: arcgisProbeResult.url,
        serviceType: arcgisProbeResult.serviceType,
        layers: arcgisProbeResult.layers.map((l) => {
          const base: { id: number; name: string; geometryType?: string } = {
            id: l.id,
            name: l.name,
          };
          if (l.geometryType) base.geometryType = l.geometryType;
          return base;
        }),
        selectedLayerIds: Array.from(arcgisSelectedLayerIds).sort(
          (a, b) => a - b,
        ),
        ...(arcgisProbeResult.bbox ? { bbox: arcgisProbeResult.bbox } : {}),
        ...(effectiveDefault !== null
          ? { defaultLayerId: effectiveDefault }
          : {}),
        probedAt: new Date().toISOString() as ISODateString,
      };
      data = staged;
    } else if (type === 'map') {
      data = DEFAULT_MAP;
    } else if (type === 'data_layer') {
      // Gentle validation: require at least one layer, each labeled.
      // Anything beyond that is advisory - a user may legitimately
      // want an empty layer to start and populate later.
      const missing = featureServiceData.layers.find(
        (l) => !l.label.trim() || !l.name.trim(),
      );
      if (missing) {
        setError(
          'Each layer needs a label and a table name before you create the item.',
        );
        return;
      }
      // Field name uniqueness within a layer - PostGIS won't let two
      // columns share a name, so catch it here before the server
      // has to reject the create.
      for (const layer of featureServiceData.layers) {
        const names = layer.fields.map((f) => f.name).filter(Boolean);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        if (dupes.length > 0) {
          setError(
            `Layer "${layer.label}" has duplicate field name(s): ${[
              ...new Set(dupes),
            ].join(', ')}.`,
          );
          return;
        }
      }
      data = featureServiceData;
    } else if (type === 'pick_list') {
      // Start a pick list empty. The detail-page editor handles
      // manual entry, CSV / XLSX upload, and paste-from-clipboard
      // import, so the wizard doesn't need a custom builder step.
      data = DEFAULT_PICK_LIST;
    } else if (type === 'geo_boundary') {
      // Start an empty boundary; detail-page editor lets the user
      // draw, upload, or paste the geometry.
      data = DEFAULT_GEO_BOUNDARY;
    } else if (type === 'basemap') {
      // Start with the empty basemap scaffold (kind=tile-url, no URL).
      // The detail-page editor (shipped separately) lets the user pick
      // a style-url / tile-url / wms source and paste the URL.
      data = DEFAULT_BASEMAP;
    } else if (type === 'wms_service') {
      // Start with the empty WMS scaffold; URL + protocol version
      // get filled in on the detail page (#35 v1 ships the type
      // structurally; the inline probe / capabilities flow follows).
      data = DEFAULT_WMS_SERVICE;
    } else if (type === 'wfs_service') {
      data = DEFAULT_WFS_SERVICE;
    } else if (type === 'folder') {
      // Empty folder; the detail page handles adding children via the
      // "Add to folder" multi-select and drag-drop in Phase 1b.
      data = DEFAULT_FOLDER;
    } else {
      data = {};
    }

    const payload = {
      type,
      title: title.trim(),
      description: description.trim(),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      access,
      thumbnailUrl,
      data,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(
          `Create failed: ${res.status}${body ? ` - ${body}` : ''}`,
        );
        return;
      }
      // Parse defensively - a missing / malformed body used to fall
      // through silently and leave the user stranded on the create
      // page with no redirect and no error.
      let saved: Item | null = null;
      try {
        saved = (await res.json()) as Item;
      } catch (parseErr) {
        console.error('Create succeeded but response was not JSON:', parseErr);
      }
      if (!saved?.id) {
        // API accepted the payload but we can't navigate to the detail
        // page. Fall back to the items list so the user still sees
        // their new item and knows the create worked.
        startTransition(() => router.push('/items'));
        return;
      }
      // data_layer still wants the ingest panel front and centre.
      // arcgis_service no longer needs #configure-arcgis because we baked
      // the probed config into dataJson above.
      const anchor = type === 'data_layer' ? '#add-data' : '';
      startTransition(() => router.push(`/items/${saved.id}${anchor}`));
    } catch (err) {
      // Network failure or thrown error inside fetch - surface it
      // rather than leaving the user staring at a silent form.
      console.error('Create request failed:', err);
      setError(
        `Create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'pick') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TYPE_OPTIONS.map((opt) => {
          const { Icon } = opt;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => pickType(opt.value)}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-colors hover:border-accent/50 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-0">
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {opt.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  // step === 'details'
  const typeOption = TYPE_OPTIONS.find((o) => o.value === type);
  const TypeIcon = typeOption?.Icon ?? Sparkles;

  return (
    <div className="space-y-8">
      {/* Selected-type header with back link. Keeps the user oriented
          without forcing a full page nav. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
            <TypeIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
              New {typeOption?.label ?? 'item'}
            </p>
            <p className="text-sm text-ink-0">{typeOption?.desc}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={backToPicker}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-muted hover:bg-surface-2 hover:text-ink-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Change type
        </button>
      </div>

      {/* Metadata (thumbnail, title, description, tags, visibility) runs
          above the type-specific builder so the item's identity is
          established before diving into schema. Matches the user's
          mental model: "I'm creating a <thing> called <name>" reads
          left-to-right instead of schema-first. */}

      <MetadataXmlImporter
        onApply={({ title: t, description: d, tags: ts }) => {
          if (t) {
            setTitle(t);
            userEditedTitleRef.current = true;
          }
          if (d) {
            setDescription(d);
            userEditedDescRef.current = true;
          }
          if (ts && ts.length > 0) setTagsText(ts.join(', '));
        }}
      />

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Thumbnail
        </label>
        <ImageUploader
          kind="item-thumb"
          value={thumbnailUrl}
          onChange={setThumbnailUrl}
          seed={title || 'new-item'}
          label={title || 'New item'}
          size="xl"
          rounded="md"
        />
      </section>

      <section className="space-y-4">
        <div>
          <label
            htmlFor="title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Title
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => {
              userEditedTitleRef.current = true;
              setTitle(e.target.value);
            }}
            placeholder="My layer, report, form..."
            maxLength={200}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="description"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => {
              userEditedDescRef.current = true;
              setDescription(e.target.value);
            }}
            placeholder="What is this, and who's it for?"
            maxLength={5000}
            rows={4}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="tags"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Tags
          </label>
          <input
            id="tags"
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="Comma separated, e.g. buildings, parcels, campus"
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-xs text-muted">
            Used for search and filtering.
          </p>
        </div>
      </section>

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Visibility
        </label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {ACCESS_OPTIONS.map(({ value, label, desc, Icon }) => {
            const selected = access === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setAccess(value)}
                className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${
                  selected
                    ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${selected ? 'text-accent' : 'text-muted'}`}
                  />
                  <span className="text-sm font-medium text-ink-1">
                    {label}
                  </span>
                </div>
                <span className="text-xs text-muted">{desc}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          You can change this later and add explicit shares from the item
          detail page.
        </p>
      </section>

      {/* Type-specific builder / probe / etc. goes at the end of the
          form, closest to the Create button, so the user's last
          interaction before submit is with the thing that's actually
          special about this item type. */}
      {type === 'arcgis_service' ? (
        <ArcgisConfigSection
          urlDraft={arcgisUrlDraft}
          onUrlChange={setArcgisUrlDraft}
          probing={arcgisProbing}
          probeResult={arcgisProbeResult}
          defaultLayerId={arcgisDefaultLayerId}
          onDefaultLayerChange={setArcgisDefaultLayerId}
          selectedLayerIds={arcgisSelectedLayerIds}
          onSelectedLayerIdsChange={setArcgisSelectedLayerIds}
          onProbe={runArcgisProbe}
          onDiscardProbe={() => {
            setArcgisProbeResult(null);
            setArcgisSelectedLayerIds(new Set());
          }}
        />
      ) : null}

      {type === 'data_layer' ? (
        <DataLayerBuilder
          value={featureServiceData}
          onChange={setDataLayerData}
        />
      ) : null}

      {error ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={backToPicker}
          disabled={submitting}
          className="h-10 rounded-md border border-border bg-surface-1 px-4 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Create item
        </button>
      </div>
    </div>
  );
}

interface ArcgisConfigProps {
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeResult: ArcgisServiceDescription | null;
  defaultLayerId: number | null;
  onDefaultLayerChange: (id: number) => void;
  /** Set of layer ids the user wants to include in this item. */
  selectedLayerIds: Set<number>;
  onSelectedLayerIdsChange: (next: Set<number>) => void;
  onProbe: () => void | Promise<void>;
  onDiscardProbe: () => void;
}

/**
 * Inline ArcGIS probe UI that replaces the separate post-create config
 * step. The user pastes a URL, probes it, confirms the default sublayer,
 * and the rest of the form works like any other create flow.
 */
function ArcgisConfigSection({
  urlDraft,
  onUrlChange,
  probing,
  probeResult,
  defaultLayerId,
  onDefaultLayerChange,
  selectedLayerIds,
  onSelectedLayerIdsChange,
  onProbe,
  onDiscardProbe,
}: ArcgisConfigProps) {
  const toggleLayer = (id: number) => {
    const next = new Set(selectedLayerIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedLayerIdsChange(next);
  };
  const selectAll = () => {
    if (!probeResult) return;
    onSelectedLayerIdsChange(new Set(probeResult.layers.map((l) => l.id)));
  };
  const selectNone = () => onSelectedLayerIdsChange(new Set());
  const selectSpatialOnly = () => {
    if (!probeResult) return;
    onSelectedLayerIdsChange(
      new Set(
        probeResult.layers
          .filter((l) => l.geometryType)
          .map((l) => l.id),
      ),
    );
  };
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div>
          <h2 className="text-sm font-semibold text-ink-0">
            Service endpoint
          </h2>
          <p className="text-xs text-muted">
            Paste the service root ({' '}
            <code className="rounded bg-surface-2 px-1">/MapServer</code> or{' '}
            <code className="rounded bg-surface-2 px-1">/FeatureServer</code>) or
            a specific layer URL. We&apos;ll read the layer list and bake it
            into the item so the map picker has it ready.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          value={urlDraft}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onProbe();
            }
          }}
          placeholder="https://host/arcgis/rest/services/OpenData/Assessor/MapServer"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="button"
          onClick={() => void onProbe()}
          disabled={probing || !urlDraft.trim()}
          className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {probing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Probe
        </button>
      </div>

      {probeResult ? (
        <div className="rounded-md border border-success/30 bg-success/5 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <Check className="h-3.5 w-3.5" />
                Service read
              </p>
              <p className="mt-1 truncate text-sm font-medium text-ink-0">
                {probeResult.name || '(unnamed service)'}
              </p>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                <span>{probeResult.serviceType}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {probeResult.layers.length}{' '}
                  {probeResult.layers.length === 1 ? 'layer' : 'layers'}
                </span>
                <span aria-hidden="true">·</span>
                <a
                  href={`${probeResult.url}?f=html`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 underline hover:text-ink-1"
                >
                  Open service <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>
            <button
              type="button"
              onClick={onDiscardProbe}
              className="shrink-0 rounded border border-border bg-surface-1 px-2 py-1 text-[11px] text-muted hover:bg-surface-2"
            >
              Clear
            </button>
          </div>

          {probeResult.layers.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  Layers to include
                  <span className="ml-1.5 text-muted normal-case tracking-normal">
                    ({selectedLayerIds.size} of{' '}
                    {probeResult.layers.length} selected)
                  </span>
                </p>
                <div className="flex items-center gap-1 text-[11px]">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    None
                  </button>
                  <button
                    type="button"
                    onClick={selectSpatialOnly}
                    title="Only layers with geometry (skip attribute-only related tables)"
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    Spatial only
                  </button>
                </div>
              </div>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
                {probeResult.layers.map((l) => {
                  const included = selectedLayerIds.has(l.id);
                  const isDefault = l.id === defaultLayerId;
                  return (
                    <li
                      key={l.id}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors ${
                        included
                          ? 'bg-surface-1 text-ink-1'
                          : 'text-muted opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleLayer(l.id)}
                        className="h-3.5 w-3.5 shrink-0 rounded border-border text-accent focus:ring-accent/30"
                        aria-label={`Include layer ${l.name}`}
                      />
                      <span className="flex-1 truncate">
                        <span className="tabular-nums text-muted">
                          {l.id}
                        </span>{' '}
                        {l.name}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                        {geometryShort(l.geometryType)}
                      </span>
                      {/* Default-layer star: radio-like, lit only for
                           the layer currently picked as default. Click
                           sets default and, if layer isn't already
                           selected, includes it. */}
                      <button
                        type="button"
                        onClick={() => {
                          if (!included) {
                            const next = new Set(selectedLayerIds);
                            next.add(l.id);
                            onSelectedLayerIdsChange(next);
                          }
                          onDefaultLayerChange(l.id);
                        }}
                        title={
                          isDefault
                            ? 'Default layer for maps consuming this item'
                            : 'Make this the default layer'
                        }
                        aria-pressed={isDefault}
                        className={`shrink-0 rounded px-1 text-[10px] font-semibold ${
                          isDefault
                            ? 'bg-accent/15 text-accent'
                            : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                        }`}
                      >
                        {isDefault ? 'DEFAULT' : 'set default'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-[11px] text-muted">
                Unchecked layers stay in the upstream service but this
                item will not expose them. The default layer is loaded
                when a map picks this item without a specific layer
                choice.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted">
          Probe first - the Create button stays disabled-looking until the
          service is read.
        </p>
      )}
    </section>
  );
}

function geometryShort(g?: string): string {
  if (!g) return 'table';
  const m = g.match(/esriGeometry(\w+)/);
  return (m?.[1] ?? g).toLowerCase();
}
