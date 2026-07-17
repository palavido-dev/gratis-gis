// SPDX-License-Identifier: AGPL-3.0-or-later
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
import type {
  DerivedLayerData,
  Item,
  ItemAccess,
  ItemType,
  ThumbnailDesign,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_DATA_LAYER,
  DEFAULT_DERIVED_LAYER,
  DEFAULT_MAP,
  defaultThumbnailDesign,
  isDerivedLayerData,
} from '@gratis-gis/shared-types';
import { ThumbnailDesigner } from '@/components/thumbnail-designer';
import { DerivedLayerBuilder } from './new/derived-layer-builder';
import { useT } from '@/lib/i18n/locale-context';

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
      | 'thumbnailDesign'
      | 'license'
    >
  >;
  /**
   * Optional pre-loaded `data` blob, surfaced in edit mode for item
   * types that have an inline recipe editor here (currently
   * `derived_layer`). Untyped on the way in so this prop can carry any
   * item type's data; consumers narrow against the type before reading.
   */
  initialData?: unknown;
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
// i18n key per license value. The catalog supplies `.label` and
// `.hint` under itemForm.licenseOption.<key> (not itemForm.license,
// which is the section label string). The empty value and 'custom'
// get stable keys so the lookup never collides with an SPDX id.
const LICENSE_KEY: Record<string, string> = {
  '': 'notSpecified',
  'CC0-1.0': 'cc0',
  'CC-BY-4.0': 'ccBy',
  'CC-BY-SA-4.0': 'ccBySa',
  'CC-BY-NC-4.0': 'ccByNc',
  'OGL-UK-3.0': 'oglUk',
  'ODbL-1.0': 'odbl',
  MIT: 'mit',
  proprietary: 'proprietary',
  custom: 'custom',
};
const LICENSE_VALUES: string[] = [
  '',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'OGL-UK-3.0',
  'ODbL-1.0',
  'MIT',
  'proprietary',
  'custom',
];

// Item types offered in the create form. Labels + descriptions
// resolve through i18n at render (itemForm.type.<value>.label / .desc).
const ITEM_TYPE_VALUES: ItemType[] = [
  'map',
  'data_layer',
  'arcgis_service',
  'form',
  'web_app',
  'report_template',
  'dashboard',
  'file',
];

const accessOptions: Array<{
  value: ItemAccess;
  Icon: typeof Lock;
}> = [
  { value: 'private', Icon: Lock },
  { value: 'org', Icon: Building2 },
  { value: 'public', Icon: Globe2 },
];

/**
 * Create/edit form for item metadata. Most type-specific editors ship
 * with their respective pillars (map authoring, form designer, etc.).
 * Derived layers are an exception: the recipe (source + pipeline) is
 * structural to the item's identity, so the same builder used in the
 * new-item wizard is rendered inline here on the edit page so a saved
 * derived layer can have its source or pipeline changed without a
 * separate UI surface. The backend's PATCH handler re-runs
 * `validateAndEnrich` whenever `data` is included in the body, so the
 * cached `outputSchema` and `bbox` stay in sync.
 */
export function ItemForm({ mode, initialValues, initialData, itemId }: Props) {
  const t = useT();
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
  //
  // CRITICAL: the API synthesizes thumbnailUrl on response when the
  // item has only a design and no legacy upload (see
  // synthesizeThumbnailUrl in items.service.ts).  That synthesized
  // URL must NEVER round-trip back through the form, or the PATCH
  // will persist it into the DB column, freezing the cache-buster
  // and breaking design updates forever.  Filter the synthesized
  // shape out at init time so the form treats "synthesized URL"
  // identically to "no upload."
  const initialThumbnailUrl =
    initialValues?.thumbnailUrl &&
    !/\/api\/portal\/items\/[^/]+\/thumbnail\.svg/.test(initialValues.thumbnailUrl)
      ? initialValues.thumbnailUrl
      : null;
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(
    initialThumbnailUrl,
  );
  // #66: thumbnail design state. Edit mode pre-populates from the
  // item; create mode lets the user customize the type-default
  // before saving (the design ships in the create payload so the
  // backend stores it instead of re-applying its own default).
  const [thumbnailDesign, setThumbnailDesign] = useState<ThumbnailDesign>(
    initialValues?.thumbnailDesign ??
      defaultThumbnailDesign(
        (initialValues?.type as ItemType | undefined) ?? type,
      ),
  );
  // setThumbnailUrl is kept reachable for legacy uploads even
  // though no UI exposes it any more; preserves existing uploaded
  // images when the edit form round-trips.
  void setThumbnailUrl;
  // License is authored via the picker below. We track the "preset"
  // separately from "custom text" so switching back to a preset
  // doesn't lose what the user typed into the custom field. A
  // known preset whose value equals the initial license auto-picks;
  // otherwise we drop into custom mode so the existing value shows.
  const initialLicense = initialValues?.license ?? '';
  const initialPresetMatch = LICENSE_VALUES.includes(initialLicense);
  const [licensePreset, setLicensePreset] = useState<string>(
    initialPresetMatch ? initialLicense : initialLicense ? 'custom' : '',
  );
  const [licenseCustom, setLicenseCustom] = useState<string>(
    initialPresetMatch ? '' : initialLicense,
  );

  // Derived-layer recipe state. Only consulted when type is
  // `derived_layer` and the form is in edit mode; for create flows the
  // wizard owns the builder. We seed from `initialData` when it looks
  // like a valid recipe and fall back to the default scaffold so the
  // builder always has a coherent value to render. The original recipe
  // (stringified) is captured once so submit can decide whether `data`
  // is actually dirty and should be sent in the PATCH body.
  const initialDerivedLayer: DerivedLayerData = isDerivedLayerData(initialData)
    ? initialData
    : DEFAULT_DERIVED_LAYER;
  const [derivedLayerData, setDerivedLayerData] =
    useState<DerivedLayerData>(initialDerivedLayer);
  const initialDerivedLayerJson = JSON.stringify(initialDerivedLayer);

  function parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  async function submit() {
    setError(null);
    if (title.trim().length === 0) {
      setError(t('itemForm.titleRequired'));
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
      thumbnailDesign,
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
    } else if (type === 'derived_layer') {
      // Only attach `data` to the PATCH when the recipe actually
      // changed. The backend re-runs validateAndEnrich whenever `data`
      // is present, which loads the source layer and recomputes the
      // schema, so omitting it on metadata-only edits keeps those
      // edits cheap and side-steps the case where the source is
      // currently inaccessible (a metadata-only save would otherwise
      // 400 on enrichment for no good reason).
      const nextJson = JSON.stringify(derivedLayerData);
      if (nextJson !== initialDerivedLayerJson) {
        // Mirror the wizard's create-time guards. Catching this on
        // the client gives a friendlier error than the backend's
        // "derived_layer.source.itemId is required" 400.
        if (!derivedLayerData.source?.itemId) {
          setError(t('itemForm.pickSourceLayer'));
          setSubmitting(false);
          return;
        }
        if (
          !Array.isArray(derivedLayerData.pipeline) ||
          derivedLayerData.pipeline.length === 0
        ) {
          setError(t('itemForm.addPipelineStep'));
          setSubmitting(false);
          return;
        }
        payload.data = derivedLayerData;
      }
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
      setError(
        t('itemForm.saveFailed', {
          method,
          status: res.status,
          detail: await res.text(),
        }),
      );
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
            {t('itemForm.itemType')}
          </label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ITEM_TYPE_VALUES.map((value) => {
              const selected = type === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setType(value)}
                  className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${
                    selected
                      ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                      : 'border-border bg-surface-1 hover:bg-surface-2'
                  }`}
                >
                  <span className="text-sm font-medium text-ink-1">
                    {t(`itemForm.type.${value}.label`)}
                  </span>
                  <span className="text-xs text-muted">
                    {t(`itemForm.type.${value}.desc`)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Title / Description / Tags come BEFORE the thumbnail
          designer so the primary content fields are the first
          thing a user sees on the page (#87b feedback). The
          designer is dense and was pushing these way down. */}
      <section className="space-y-4">
        <div>
          <label
            htmlFor="title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            {t('itemForm.title')}
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('itemForm.titlePlaceholder')}
            maxLength={200}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="description"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            {t('itemForm.description')}
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('itemForm.descriptionPlaceholder')}
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
            {t('itemForm.tags')}
          </label>
          <input
            id="tags"
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder={t('itemForm.tagsPlaceholder')}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-xs text-muted">
            {t('itemForm.tagsHint')}
          </p>
        </div>
      </section>

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          {t('itemForm.thumbnail')}
        </label>
        <ThumbnailDesigner
          type={type}
          title={title}
          value={thumbnailDesign}
          onChange={setThumbnailDesign}
        />
      </section>

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          {t('itemForm.visibility')}
        </label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {accessOptions.map(({ value, Icon }) => {
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
                    {t(`itemForm.access.${value}.label`)}
                  </span>
                </div>
                <span className="text-xs text-muted">
                  {t(`itemForm.access.${value}.desc`)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode.kind === 'create'
            ? t('itemForm.visibilityHintCreate')
            : t('itemForm.visibilityHintEdit')}
        </p>
      </section>

      <section>
        <label
          htmlFor="license-preset"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          {t('itemForm.license')}
        </label>
        <p className="mb-2 text-xs text-muted">
          {t('itemForm.licenseHintPrefix')}{' '}
          (<code className="font-mono">/public/catalog.json</code>){' '}
          {t('itemForm.licenseHintSuffix')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            id="license-preset"
            value={licensePreset}
            onChange={(e) => setLicensePreset(e.target.value)}
            className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:w-72"
          >
            {LICENSE_VALUES.map((value) => (
              <option key={value || 'none'} value={value}>
                {t(`itemForm.licenseOption.${LICENSE_KEY[value]}.label`)}
              </option>
            ))}
          </select>
          {licensePreset === 'custom' ? (
            <input
              type="text"
              value={licenseCustom}
              onChange={(e) => setLicenseCustom(e.target.value)}
              placeholder={t('itemForm.licenseCustomPlaceholder')}
              className="h-10 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          ) : null}
        </div>
        {licensePreset && licensePreset !== 'custom' ? (
          <p className="mt-1 text-2xs text-muted">
            {t(`itemForm.licenseOption.${LICENSE_KEY[licensePreset]}.hint`)}
          </p>
        ) : null}
      </section>

      {/* Derived-layer recipe editor. Mirrors the wizard's inline
          builder so editing parity matches creation parity: source
          and pipeline can be changed from the same UI a user already
          knows. The backend re-enriches outputSchema and bbox on
          save, so this surface stays purely structural. */}
      {mode.kind === 'edit' && type === 'derived_layer' ? (
        <section>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
            {t('itemForm.recipe')}
          </label>
          <DerivedLayerBuilder
            value={derivedLayerData}
            onChange={setDerivedLayerData}
          />
        </section>
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
        {saved ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" />
            {t('mapEditor.savedIndicator')}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => router.back()}
          disabled={submitting || pending}
          className="h-10 rounded-md border border-border bg-surface-1 px-4 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {t('common.cancel')}
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
          {mode.kind === 'create'
            ? t('newItem.createButton')
            : t('itemForm.saveChanges')}
        </button>
      </div>
    </div>
  );
}
