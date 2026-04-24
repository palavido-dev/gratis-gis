'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Building2,
  Check,
  Globe2,
  Loader2,
  Lock,
  Save,
  Sparkles,
} from 'lucide-react';
import type { Item, ItemAccess, ItemType } from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_DATA_LAYER,
  DEFAULT_MAP,
} from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';

type Mode =
  | { kind: 'create' }
  | { kind: 'edit'; itemId: string };

interface Props {
  mode: Mode;
  initialValues?: Partial<
    Pick<
      Item,
      | 'type'
      | 'title'
      | 'description'
      | 'tags'
      | 'access'
      | 'thumbnailUrl'
      | 'license'
    >
  >;
  /** Item id in edit mode, used as a stable seed for the fallback badge. */
  itemId?: string;
}

/**
 * Preset list for the license picker. Matches the most common
 * open-data choices (SPDX-compatible ids where possible) plus a
 * "custom" escape hatch for anything the portal's operators
 * want to use that isn't in the menu. Surfaced on DCAT feeds as
 * the dcat:license field.
 */
const LICENSE_OPTIONS: Array<{ value: string; label: string; hint?: string }> = [
  { value: '', label: 'Not specified', hint: 'Treated as "rights reserved"' },
  { value: 'CC0-1.0', label: 'CC0 (public domain)', hint: 'No rights reserved' },
  { value: 'CC-BY-4.0', label: 'CC BY 4.0', hint: 'Reuse with attribution' },
  {
    value: 'CC-BY-SA-4.0',
    label: 'CC BY-SA 4.0',
    hint: 'Attribution + share-alike',
  },
  {
    value: 'CC-BY-NC-4.0',
    label: 'CC BY-NC 4.0',
    hint: 'Attribution, non-commercial',
  },
  { value: 'OGL-UK-3.0', label: 'UK Open Government Licence v3', hint: '' },
  { value: 'ODbL-1.0', label: 'Open Database License 1.0', hint: '' },
  { value: 'MIT', label: 'MIT', hint: 'Permissive; common for datasets too' },
  {
    value: 'proprietary',
    label: 'Proprietary / rights reserved',
    hint: 'Internal use only',
  },
  { value: 'custom', label: 'Custom…', hint: 'Specify your own value' },
];

const ITEM_TYPE_OPTIONS: Array<{ value: ItemType; label: string; desc: string }> = [
  {
    value: 'map' as ItemType,
    label: 'Map',
    desc: 'A basemap + overlay layers with styling.',
  },
  {
    value: 'data_layer' as ItemType,
    label: 'Data layer',
    desc: 'A shareable vector layer backed by PostGIS.',
  },
  {
    value: 'arcgis_service' as ItemType,
    label: 'ArcGIS service',
    desc: 'Live pointer at an ArcGIS MapServer or FeatureServer.',
  },
  {
    value: 'form' as ItemType,
    label: 'Form',
    desc: 'A collection form for fieldwork or survey data.',
  },
  {
    value: 'web_app' as ItemType,
    label: 'Web app',
    desc: 'A configurable app built from widgets.',
  },
  {
    value: 'report_template' as ItemType,
    label: 'Report template',
    desc: 'A document template that renders data.',
  },
  {
    value: 'dashboard' as ItemType,
    label: 'Dashboard',
    desc: 'Live panels showing feature data.',
  },
  {
    value: 'notebook' as ItemType,
    label: 'Notebook',
    desc: 'A Jupyter notebook hosted in the portal.',
  },
  {
    value: 'file' as ItemType,
    label: 'File',
    desc: 'Any uploaded file (PDF, image, zip, etc.).',
  },
];

const accessOptions: Array<{
  value: ItemAccess;
  label: string;
  desc: string;
  Icon: typeof Lock;
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

/**
 * Create/edit form for item metadata. Data payload is not edited here —
 * type-specific editors (map authoring, form designer, etc.) ship with
 * their respective pillars. On create, the payload defaults to {}.
 */
export function ItemForm({ mode, initialValues, itemId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<ItemType>(
    (initialValues?.type as ItemType) ?? 'map',
  );
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [description, setDescription] = useState(
    initialValues?.description ?? '',
  );
  const [tagsText, setTagsText] = useState(
    (initialValues?.tags ?? []).join(', '),
  );
  const [access, setAccess] = useState<ItemAccess>(
    (initialValues?.access as ItemAccess) ?? 'private',
  );
  // Thumbnail state lives in the form so the uploader can update it
  // between renders and we ship the current URL with the submit.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(
    initialValues?.thumbnailUrl ?? null,
  );
  // License is authored via the picker below. We track the "preset"
  // separately from "custom text" so switching back to a preset
  // doesn't lose what the user typed into the custom field. A
  // known preset whose value equals the initial license auto-picks;
  // otherwise we drop into custom mode so the existing value shows.
  const initialLicense = initialValues?.license ?? '';
  const initialPreset = LICENSE_OPTIONS.find(
    (o) => o.value === initialLicense,
  );
  const [licensePreset, setLicensePreset] = useState<string>(
    initialPreset ? initialPreset.value : initialLicense ? 'custom' : '',
  );
  const [licenseCustom, setLicenseCustom] = useState<string>(
    initialPreset ? '' : initialLicense,
  );

  function parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  async function submit() {
    setError(null);
    if (title.trim().length === 0) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);

    // Resolve the effective license value from the picker. Empty
    // preset + empty custom = explicit "not set"; the backend accepts
    // null to clear a previously-set license.
    const effectiveLicense =
      licensePreset === 'custom'
        ? licenseCustom.trim() || null
        : licensePreset === ''
          ? null
          : licensePreset;

    const payload: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      tags: parseTags(tagsText),
      access,
      thumbnailUrl,
      license: effectiveLicense,
    };
    if (mode.kind === 'create') {
      payload.type = type;
      // Seed type-specific defaults so the new item renders something
      // meaningful immediately. Other types can fall through to {} and
      // get populated by their dedicated editor on the detail page.
      payload.data =
        type === 'map'
          ? DEFAULT_MAP
          : type === 'data_layer'
            ? DEFAULT_DATA_LAYER
            : type === 'arcgis_service'
              ? DEFAULT_ARCGIS_SERVICE
              : {};
    }

    const url =
      mode.kind === 'create'
        ? '/api/portal/items'
        : `/api/portal/items/${mode.itemId}`;
    const method = mode.kind === 'create' ? 'POST' : 'PATCH';

    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(`${method} failed: ${res.status} ${await res.text()}`);
      return;
    }
    const saved = (await res.json()) as Item;
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);

    if (mode.kind === 'create') {
      // Navigate to the new item's detail page. For types whose first
      // job on arrival is to bring data in (data_layer), jump
      // directly to the ingest anchor so the upload panel is the very
      // first thing the user sees.
      const anchor =
        type === 'data_layer'
          ? '#add-data'
          : type === 'arcgis_service'
            ? '#configure-arcgis'
            : '';
      startTransition(() => router.push(`/items/${saved.id}${anchor}`));
    } else {
      // Stay on the edit page but refresh the server data so any downstream
      // consumers see the update.
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="space-y-8">
      {mode.kind === 'create' ? (
        <section>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
            Item type
          </label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ITEM_TYPE_OPTIONS.map((opt) => {
              const selected = type === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setType(opt.value)}
                  className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${
                    selected
                      ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                      : 'border-border bg-surface-1 hover:bg-surface-2'
                  }`}
                >
                  <span className="text-sm font-medium text-ink-1">
                    {opt.label}
                  </span>
                  <span className="text-xs text-muted">{opt.desc}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Thumbnail
        </label>
        <ImageUploader
          kind="item-thumb"
          value={thumbnailUrl}
          onChange={setThumbnailUrl}
          seed={
            mode.kind === 'edit'
              ? mode.itemId
              : (itemId ?? title) || 'new-item'
          }
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
            onChange={(e) => setTitle(e.target.value)}
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
            onChange={(e) => setDescription(e.target.value)}
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
          {accessOptions.map(({ value, label, desc, Icon }) => {
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
                  <span className="text-sm font-medium text-ink-1">{label}</span>
                </div>
                <span className="text-xs text-muted">{desc}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode.kind === 'create' ? (
            <>You can change this later and add explicit shares from the item detail page.</>
          ) : (
            <>Refine with per-user or per-group shares from the detail page.</>
          )}
        </p>
      </section>

      <section>
        <label
          htmlFor="license-preset"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          License
        </label>
        <p className="mb-2 text-xs text-muted">
          How others are allowed to reuse this item. Surfaced in the
          org's open-data catalog (<code className="font-mono">/public/catalog.json</code>)
          for public items.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            id="license-preset"
            value={licensePreset}
            onChange={(e) => setLicensePreset(e.target.value)}
            className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:w-72"
          >
            {LICENSE_OPTIONS.map((o) => (
              <option key={o.value || 'none'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {licensePreset === 'custom' ? (
            <input
              type="text"
              value={licenseCustom}
              onChange={(e) => setLicenseCustom(e.target.value)}
              placeholder="SPDX id or license URL (e.g. https://creativecommons.org/licenses/by/4.0/)"
              className="h-10 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          ) : null}
        </div>
        {licensePreset && licensePreset !== 'custom' ? (
          <p className="mt-1 text-[11px] text-muted">
            {LICENSE_OPTIONS.find((o) => o.value === licensePreset)?.hint}
          </p>
        ) : null}
      </section>

      {error ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {saved ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" />
            Saved
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => router.back()}
          disabled={submitting || pending}
          className="h-10 rounded-md border border-border bg-surface-1 px-4 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || pending}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode.kind === 'create' ? (
            <Sparkles className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {mode.kind === 'create' ? 'Create item' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
