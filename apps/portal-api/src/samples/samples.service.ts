// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ItemAccess, ItemType, Prisma } from '@prisma/client';
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_VIEWER_TOOLS,
  STARTERS,
  selectByLocationRecipe,
  type DataCollectionData,
  type DataLayerDataV3,
  type DerivedLayerData,
  type FeatureField,
  type FolderData,
  type GeoBoundaryData,
  type MapData,
  type MapLayer,
  type PickListData,
  type PickListEntry,
  type ToolItemData,
  type ViewerData,
  type WebAppData,
} from '@gratis-gis/shared-types';
import type { FormSchema, Question } from '@gratis-gis/form-schema';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { hasCapability } from '../auth/capabilities.js';
import { ItemsService } from '../items/items.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { FormsService } from '../forms/forms.service.js';
import { loadSampleAssets, type SampleFeature } from './sample-assets.js';
import { deterministicSampleUuid } from './sample-uuid.js';

/**
 * Per-org "Load sample data" seeder (#147 Phase 1).
 *
 * Seeds the curated Randolph County, WV scenario described in
 * docs/handoff/sample-content-manifest.md: pick lists, three feature
 * layers with real rows, a boundary, two maps, a derived layer, a
 * form with four submissions, a field deployment, two apps, a tool,
 * and a folder tying it together.
 *
 * Idempotency contract: every seeded item carries
 * `seedKind: 'sample:<slug>'`. There is no DB unique on seedKind, so
 * dedupe is application-level: the run loads every existing
 * `sample:*` item up front, skips slugs that are present, and reuses
 * their ids when later items reference them, so a re-run after a
 * partial failure finishes the job instead of duplicating it.
 * Features dedupe by "does the layer have any rows yet", and form
 * submissions ride FormsService.submit's (formId, clientId) upsert.
 */

/** Seed-kind slug per manifest entry, in seed order. The `file-guide`
 *  entry from the manifest is deliberately absent: the bundled PDF is
 *  not part of this implementation, so the seeder neither creates the
 *  file item nor lists it in the folder. */
export const SAMPLE_KINDS = {
  pickFacility: 'sample:pick-facility-type',
  pickTrail: 'sample:pick-trail-class',
  layerFacilities: 'sample:layer-facilities',
  layerTrails: 'sample:layer-trails',
  layerParks: 'sample:layer-parks',
  layerParcels: 'sample:layer-parcels',
  boundary: 'sample:boundary-county',
  mapExplorer: 'sample:map-explorer',
  mapParcels: 'sample:map-parcels',
  derivedEmergency: 'sample:derived-emergency',
  form: 'sample:form-issue-report',
  mapField: 'sample:map-field',
  collection: 'sample:collection-trail-survey',
  appViewer: 'sample:app-viewer',
  appExplorer: 'sample:app-explorer',
  tool: 'sample:tool-near-me',
  folder: 'sample:folder-root',
} as const;

export interface SeedSampleDataResult {
  created: string[];
  skipped: string[];
}

/** Sublayer ids inside the seeded data_layer items. Also used as the
 *  MapLayerSource layerKey on every map reference. */
const FACILITIES_SUBLAYER = 'facilities';
const TRAILS_SUBLAYER = 'trails';
const PARKS_SUBLAYER = 'parks';
const PARCELS_SUBLAYER = 'parcels';

/** Brand-adjacent palette from the manifest: sage trails, clay
 *  facilities, muted green parks, muted mauve for field reports. */
const TRAILS_COLOR = '#59695a';
const FACILITIES_COLOR = '#b08e62';
const PARKS_COLOR = '#7c8a6e';
const PARCELS_COLOR = '#a99a86';
const REPORTS_COLOR = '#8d6a75';

const SAMPLE_TAGS = ['sample', 'randolph'];

/** Provenance / attribution lines. The mapWV Terms of Use place WV GIS
 *  Technical Center content in the public domain for redistribution
 *  (with per-dataset caveats, checked for the layers used here); the
 *  USFS trail data is a federal public-domain work. Kept in each
 *  layer's description so the source travels with the data. */
const SRC_WVGISTC = 'Source: WV GIS Technical Center (wvgis.wvu.edu).';
const SRC_USFS =
  'Source: USDA Forest Service, National Forest System Trails.';
const SRC_WVDNR_USFS =
  'Source: WV GIS Technical Center, WV DNR, and USDA Forest Service.';

const FACILITY_TYPE_ENTRIES: PickListEntry[] = [
  { code: 'school', label: 'School' },
  { code: 'college', label: 'College' },
  { code: 'library', label: 'Library' },
  { code: 'fire', label: 'Fire station' },
  { code: 'ems', label: 'EMS' },
  { code: 'hospital', label: 'Hospital' },
  { code: 'law-enforcement', label: 'Law enforcement' },
];

const TRAIL_CLASS_ENTRIES: PickListEntry[] = [
  { code: '1', label: 'Class 1: Minimally developed' },
  { code: '2', label: 'Class 2: Moderately developed' },
  { code: '3', label: 'Class 3: Developed' },
  { code: '4', label: 'Class 4: Highly developed' },
  { code: '5', label: 'Class 5: Fully developed' },
];

/** Choice codes must match the bundled submissions.json responses. */
const ISSUE_TYPE_CHOICES = [
  { value: 'washout', label: 'Road washout' },
  { value: 'downed-tree', label: 'Downed tree' },
  { value: 'pothole', label: 'Pothole' },
  { value: 'signage', label: 'Missing or damaged signage' },
  { value: 'other', label: 'Other' },
];

const SEVERITY_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** What one resolved manifest entry looks like inside a run. */
interface EnsuredItem {
  id: string;
  data: unknown;
  access: ItemAccess;
  wasCreated: boolean;
}

@Injectable()
export class SamplesService {
  private readonly log = new Logger(SamplesService.name);

  /**
   * Per-org in-flight promise, same coalescing pattern as
   * AuthSyncService.ensureBuiltinBasemaps: a double-click (or two
   * admins racing) shares one seed run instead of interleaving two
   * dedupe-then-create passes that would each see the same empty
   * state. Cleared once settled so a failed run can be retried.
   */
  private readonly seedInFlight = new Map<
    string,
    Promise<SeedSampleDataResult>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly features: DataLayerFeaturesService,
    private readonly forms: FormsService,
  ) {}

  async seedSampleData(user: AuthUser): Promise<SeedSampleDataResult> {
    // Same capability that gates publishing anything else: viewers
    // cannot create items, so they cannot seed fifteen of them.
    if (!hasCapability(user, 'can_publish_items')) {
      throw new ForbiddenException(
        'Loading sample data requires the contributor or admin role.',
      );
    }
    let inFlight = this.seedInFlight.get(user.orgId);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          return await this.runSeed(user);
        } finally {
          this.seedInFlight.delete(user.orgId);
        }
      })();
      this.seedInFlight.set(user.orgId, inFlight);
    }
    return inFlight;
  }

  private async runSeed(user: AuthUser): Promise<SeedSampleDataResult> {
    const assets = await loadSampleAssets();

    // Application-level dedupe: load every sample:* item in the org
    // up front, including trashed rows. A trashed sample still counts
    // as seeded (matching the basemap seeder's behaviour) so a
    // re-click never plants a duplicate workspace.
    const existingRows = await this.prisma.item.findMany({
      where: { orgId: user.orgId, seedKind: { startsWith: 'sample:' } },
      select: { id: true, type: true, data: true, access: true, seedKind: true },
    });
    const existingBySlug = new Map(
      existingRows
        .filter((r) => typeof r.seedKind === 'string')
        .map((r) => [r.seedKind as string, r]),
    );

    const created: string[] = [];
    const skipped: string[] = [];

    const ensure = async (
      slug: string,
      build: () => {
        type: ItemType;
        title: string;
        description: string;
        data: unknown;
      },
    ): Promise<EnsuredItem> => {
      const existing = existingBySlug.get(slug);
      if (existing) {
        skipped.push(slug);
        return {
          id: existing.id,
          data: existing.data,
          access: existing.access,
          wasCreated: false,
        };
      }
      const spec = build();
      const row = await this.items.create(user, {
        type: spec.type,
        title: spec.title,
        description: spec.description,
        tags: SAMPLE_TAGS,
        data: spec.data as Prisma.InputJsonValue,
        seedKind: slug,
      });
      created.push(slug);
      return { id: row.id, data: row.data, access: row.access, wasCreated: true };
    };

    // 1 + 2: pick lists first; the layer schemas reference them.
    const pickFacility = await ensure(SAMPLE_KINDS.pickFacility, () => ({
      type: 'pick_list',
      title: 'Facility types',
      description:
        'Reusable facility categories backing the County facilities sample layer. Sample content.',
      data: this.pickListData(FACILITY_TYPE_ENTRIES),
    }));
    const pickTrail = await ensure(SAMPLE_KINDS.pickTrail, () => ({
      type: 'pick_list',
      title: 'Trail class',
      description:
        'Reusable USFS trail-class ratings backing the Trails sample layer. Sample content.',
      data: this.pickListData(TRAIL_CLASS_ENTRIES),
    }));

    // 3 - 5: data layers, each followed by its bundled features.
    const facilities = await ensure(SAMPLE_KINDS.layerFacilities, () => ({
      type: 'data_layer',
      title: 'County facilities',
      description: `Public facilities across Randolph County, WV: schools, college, libraries, fire and EMS, hospital, and law enforcement. ${SRC_WVGISTC}`,
      data: this.facilitiesLayerData(pickFacility.id),
    }));
    await this.ensureLayerFeatures(
      user,
      facilities.id,
      FACILITIES_SUBLAYER,
      assets.facilities,
    );

    const trails = await ensure(SAMPLE_KINDS.layerTrails, () => ({
      type: 'data_layer',
      title: 'Trails',
      description: `Monongahela National Forest trails within Randolph County, with USFS trail class and mileage. ${SRC_USFS}`,
      data: this.trailsLayerData(pickTrail.id),
    }));
    await this.ensureLayerFeatures(
      user,
      trails.id,
      TRAILS_SUBLAYER,
      assets.trails,
    );

    const parks = await ensure(SAMPLE_KINDS.layerParks, () => ({
      type: 'data_layer',
      title: 'Parks and public lands',
      description: `Parks and public lands in Randolph County, WV: national forest, state forest, wildlife management areas, nature preserves, and city parks. ${SRC_WVDNR_USFS}`,
      data: this.parksLayerData(),
    }));
    await this.ensureLayerFeatures(
      user,
      parks.id,
      PARKS_SUBLAYER,
      assets.parks,
    );

    // 5b: the full Randolph County parcel fabric. This is the
    // real-world-scale layer: every tax parcel in the county, not a
    // curated handful, so the demo shows how the portal handles a
    // county cadastre instead of a toy dataset.
    const parcels = await ensure(SAMPLE_KINDS.layerParcels, () => ({
      type: 'data_layer',
      title: 'Randolph County parcels',
      description: `All ${assets.parcels.length.toLocaleString()} tax parcels in Randolph County, WV, with owner, physical address, and acreage. ${SRC_WVGISTC}`,
      data: this.parcelsLayerData(),
    }));
    await this.ensureLayerFeatures(
      user,
      parcels.id,
      PARCELS_SUBLAYER,
      assets.parcels,
    );

    // 6: shared county boundary.
    const boundaryFeature = assets.boundary[0];
    const boundaryGeometry: GeoBoundaryData['geometry'] = boundaryFeature
      ? (boundaryFeature.geometry as unknown as GeoBoundaryData['geometry'])
      : null;
    const boundary = await ensure(SAMPLE_KINDS.boundary, () => ({
      type: 'geo_boundary',
      title: 'Randolph County boundary',
      description:
        'Authoritative Randolph County boundary from the WV 24K county boundary layer (USGS / WVDEP via the WV GIS Technical Center), lightly generalized for size.',
      data: {
        version: 1,
        geometry: boundaryGeometry,
        note: 'Randolph County boundary, generalized slightly from the authoritative WV 24K boundary. Source: WV GIS Technical Center.',
      } satisfies GeoBoundaryData,
    }));

    // 7: explorer map over the three curated layers.
    const explorer = await ensure(SAMPLE_KINDS.mapExplorer, () => ({
      type: 'map',
      title: 'Randolph County explorer',
      description:
        'Facilities, trails, and parks over the default basemap, centered on Elkins. Sample content.',
      data: this.explorerMapData(facilities.id, trails.id, parks.id),
    }));

    // 7b: a dedicated parcels map, centered tight on Elkins so the
    // individual parcels are legible. Kept separate from the public
    // explorer map because the parcel layer is org-tier (see access
    // tiers below), and mixing an org-tier layer into a public map is
    // the documented anonymous-viewer footgun.
    const parcelsMap = await ensure(SAMPLE_KINDS.mapParcels, () => ({
      type: 'map',
      title: 'Randolph County parcels',
      description:
        'The full county parcel fabric over the default basemap, centered on Elkins. Search parcels by owner. Sample content.',
      data: this.parcelsMapData(parcels.id),
    }));

    // 8: derived layer filtered to emergency facilities. Created via
    // ItemsService.create so the recipe is validated and enriched
    // (outputSchema + bbox) exactly like a user-authored one; the
    // source layer exists and is readable by this point in the order.
    const derived = await ensure(SAMPLE_KINDS.derivedEmergency, () => ({
      type: 'derived_layer',
      title: 'Emergency services',
      description:
        'County facilities filtered to fire, EMS, and hospital. Demonstrates derived layers: a saved recipe that stays in sync with its source.',
      data: this.emergencyDerivedLayerData(facilities.id),
    }));

    // 9: the issue-report form. ItemsService.create auto-pairs a
    // submissions data_layer and stamps linkedLayerId / linkedLayerKey
    // into the form's data.
    const form = await ensure(SAMPLE_KINDS.form, () => ({
      type: 'form',
      title: 'Road and trail issue report',
      description:
        'Collect road and trail problems from the field: location, issue type, severity, and a description. Sample content.',
      data: this.issueReportFormSchema(),
    }));
    let formData = form.data as Record<string, unknown> | null;
    if (form.wasCreated) {
      // FormSchema.id matches the form item id by contract; the id
      // does not exist until the row does, so backfill in a second
      // write (the designer's emptyForm() does the same thing from
      // the client side).
      const updated = await this.items.update(user, form.id, {
        data: {
          ...(formData ?? {}),
          id: form.id,
        } as Prisma.InputJsonValue,
      });
      formData = updated.data as Record<string, unknown> | null;
    }
    const linkedLayerId =
      formData && typeof formData.linkedLayerId === 'string'
        ? formData.linkedLayerId
        : null;
    const linkedLayerKey =
      formData && typeof formData.linkedLayerKey === 'string'
        ? formData.linkedLayerKey
        : 'submissions';
    if (!linkedLayerId) {
      // Without the paired layer there is nowhere for submissions to
      // mirror and nothing for the field map to render. This state
      // means the form item predates auto-pairing or was hand-edited;
      // surface it instead of seeding a silently broken field story.
      throw new ConflictException(
        'The sample form has no paired submissions layer (data.linkedLayerId is missing). Delete the sample form item and load sample data again.',
      );
    }
    // Mirror the form designer's save-time schema sync so the paired
    // layer gains typed question columns and, crucially, a point
    // geometry (the paired layer is born attribute-only; without the
    // promotion every mirrored submission would land geometry-less
    // and the field map would render nothing).
    await this.syncPairedIssueLayer(user, linkedLayerId, linkedLayerKey);

    // 10: four submissions. FormsService.submit upserts on
    // (formId, clientId) so re-runs are no-ops, and it mirrors each
    // first-write into the paired layer with the form's geometry
    // binding.
    for (const sub of assets.submissions) {
      await this.forms.submit(form.id, user, {
        clientId: sub.clientId,
        schemaVersion: 1,
        response: sub.response,
        capturedAt: sub.capturedAt,
      });
    }

    // 11: field operations map: facilities + the mirrored reports.
    const fieldMap = await ensure(SAMPLE_KINDS.mapField, () => ({
      type: 'map',
      title: 'Field operations',
      description:
        'County facilities plus incoming road and trail issue reports, centered on the Tygart Valley. Sample content.',
      data: this.fieldMapData(facilities.id, linkedLayerId, linkedLayerKey),
    }));

    // 12: field deployment wrapping the field map, with the form
    // explicitly bound to the submissions layer.
    const collection = await ensure(SAMPLE_KINDS.collection, () => ({
      type: 'data_collection',
      title: 'Trail conditions field survey',
      description:
        'Offline-capable field deployment: open on a phone, tap the map, file a road or trail issue report. Sample content.',
      data: {
        version: 1,
        mapId: fieldMap.id,
        formBindings: { [linkedLayerKey]: { formItemId: form.id } },
      } satisfies DataCollectionData,
    }));

    // 13: read-only viewer app over the explorer map.
    const viewerApp = await ensure(SAMPLE_KINDS.appViewer, () => ({
      type: 'web_app',
      title: 'Public facilities viewer',
      description:
        'Read-only viewer for county facilities with search. Works for anonymous visitors once shared publicly. Sample content.',
      data: this.viewerAppData(explorer.id, facilities.id),
    }));

    // 14: custom app stamped from the sidebar-explorer starter.
    const appExplorer = await ensure(SAMPLE_KINDS.appExplorer, () => ({
      type: 'web_app',
      title: 'Randolph County explorer app',
      description:
        'Custom app built from the Sidebar Explorer starter: layer list, legend, and attribute table over the explorer map. Sample content.',
      data: this.explorerAppData(explorer.id, facilities.id),
    }));

    // 15: a runnable tool.
    const tool = await ensure(SAMPLE_KINDS.tool, () => ({
      type: 'tool',
      title: 'Find facilities near a location',
      description:
        'Select By Location recipe: draw an area on any map hosting this tool and select the facilities inside or near it. Sample content.',
      data: {
        schemaVersion: 1,
        action: selectByLocationRecipe(),
        hint: 'Draw an area on the map, pick a spatial relationship, and select matching facilities.',
      } satisfies ToolItemData,
    }));

    // 16 (manifest 17): the folder listing every seeded item, in
    // manifest order. The auto-paired submissions layer is server
    // plumbing rather than a manifest entry, so it stays out of the
    // folder; the PDF guide is skipped in this implementation.
    const folderChildren = [
      pickFacility.id,
      pickTrail.id,
      facilities.id,
      trails.id,
      parks.id,
      parcels.id,
      boundary.id,
      explorer.id,
      parcelsMap.id,
      derived.id,
      form.id,
      fieldMap.id,
      collection.id,
      viewerApp.id,
      appExplorer.id,
      tool.id,
    ];
    await ensure(SAMPLE_KINDS.folder, () => ({
      type: 'folder',
      title: 'Sample: Randolph County',
      description:
        'Everything "Load sample data" created, in one place. Safe to explore, edit, or delete.',
      data: { version: 1, childItemIds: folderChildren } satisfies FolderData,
    }));

    // Access tiers last, so every referenced item exists before any
    // of them becomes visible beyond the owner. Facilities layer +
    // explorer map + viewer app go public together (the anonymous
    // viewer needs the whole chain); trails + parks demonstrate the
    // org tier; everything else stays private.
    await this.applyAccessTier(user, facilities, 'public');
    await this.applyAccessTier(user, explorer, 'public');
    await this.applyAccessTier(user, viewerApp, 'public');
    await this.applyAccessTier(user, parks, 'org');
    await this.applyAccessTier(user, trails, 'org');
    await this.applyAccessTier(user, parcels, 'org');
    await this.applyAccessTier(user, parcelsMap, 'org');

    this.log.log(
      `Sample data seed for org=${user.orgId}: created ${created.length}, skipped ${skipped.length}`,
    );
    return { created, skipped };
  }

  /** Set an item's access tier when it differs from the target.
   *  Freshly created items are always 'private' (the seeder never
   *  passes access at create time), so this is also the only write
   *  that widens anything. */
  private async applyAccessTier(
    user: AuthUser,
    item: EnsuredItem,
    access: ItemAccess,
  ): Promise<void> {
    const current: ItemAccess = item.wasCreated ? 'private' : item.access;
    if (current === access) return;
    await this.items.update(user, item.id, { access });
  }

  /**
   * Insert the bundled features for a layer unless it already has
   * rows. The row-presence probe (LIMIT 1) rather than a per-feature
   * upsert keeps re-runs from appending redundant create observations
   * to the log; entity ids are still deterministic per feature slug
   * so a future targeted repair can address individual rows.
   */
  private async ensureLayerFeatures(
    user: AuthUser,
    itemId: string,
    layerId: string,
    features: SampleFeature[],
  ): Promise<void> {
    const current = await this.features.listFeatures(itemId, layerId, {
      limit: 1,
    });
    if (current.features.length > 0) return;
    // Chunk the insert: the parcels layer alone is ~24k features, well
    // past what a single multi-row insert can bind in one statement.
    // Small layers fall through in a single batch.
    const BATCH = 1000;
    for (let i = 0; i < features.length; i += BATCH) {
      await this.features.insertFeatures(
        itemId,
        layerId,
        features.slice(i, i + BATCH).map((f) => ({
          globalId: deterministicSampleUuid(`${itemId}:${f.id}`),
          geometry: f.geometry,
          properties: f.properties,
        })),
        user,
      );
    }
  }

  /**
   * Server-side twin of the form designer's syncPairedLayerColumns
   * (apps/portal-web .../form/designer.tsx): additive typed columns
   * for the form's questions, geometryType promotion from null to
   * 'point' (the form's geopoint question), and the respondent
   * row-isolation policy. Idempotent: a re-run with nothing to add
   * skips the write entirely.
   */
  private async syncPairedIssueLayer(
    user: AuthUser,
    layerItemId: string,
    layerKey: string,
  ): Promise<void> {
    const row = await this.prisma.item.findUnique({
      where: { id: layerItemId },
      select: { data: true },
    });
    if (!row) {
      throw new ConflictException(
        'The sample form references a paired submissions layer that does not exist.',
      );
    }
    const data = (row.data ?? {}) as Record<string, unknown>;
    const layers = Array.isArray(data.layers)
      ? ([...data.layers] as Array<Record<string, unknown>>)
      : [];
    const subIdx = layers.findIndex(
      (l) => l.id === layerKey || l.name === layerKey,
    );
    if (subIdx < 0) {
      throw new ConflictException(
        `The paired submissions layer has no sublayer "${layerKey}" to sync the form schema into.`,
      );
    }
    const sub = layers[subIdx]!;
    const existingFields = Array.isArray(sub.fields)
      ? (sub.fields as Array<{ name?: unknown }>)
      : [];
    const existingNames = new Set(
      existingFields
        .map((f) => (typeof f.name === 'string' ? f.name : null))
        .filter((n): n is string => n !== null),
    );
    const toAdd = this.issueFormLayerFields().filter(
      (f) => !existingNames.has(f.name),
    );
    const wantGeometry =
      sub.geometryType === null || sub.geometryType === undefined;
    const wantPolicy = sub.editingPolicy !== 'own-rows-only';
    if (toAdd.length === 0 && !wantGeometry && !wantPolicy) return;

    layers[subIdx] = {
      ...sub,
      fields: [...existingFields, ...toAdd],
      ...(wantGeometry ? { geometryType: 'point' } : {}),
      // Respondent isolation, same as the designer (#346): share
      // recipients of the paired layer see only their own rows.
      ...(wantPolicy ? { editingPolicy: 'own-rows-only' } : {}),
    };
    await this.items.update(user, layerItemId, {
      data: { ...data, layers } as Prisma.InputJsonValue,
    });
  }

  // -------------------------------------------------------------------------
  // Payload builders
  // -------------------------------------------------------------------------

  private pickListData(entries: PickListEntry[]): PickListData {
    return {
      version: 3,
      entries,
      note: 'Part of the bundled sample content. Edit or delete freely.',
    };
  }

  private facilitiesLayerData(facilityPickListId: string): DataLayerDataV3 {
    const fields: FeatureField[] = [
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        nullable: false,
        searchable: true,
      },
      {
        name: 'type',
        type: 'string',
        label: 'Facility type',
        nullable: false,
        domain: {
          type: 'coded-value-ref',
          pickListItemId: facilityPickListId,
        },
      },
      { name: 'community', type: 'string', label: 'Community', nullable: true },
      { name: 'notes', type: 'string', label: 'Notes', nullable: true },
    ];
    return {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: FACILITIES_SUBLAYER,
          label: 'Facilities',
          name: FACILITIES_SUBLAYER,
          geometryType: 'point',
          fields,
          editingEnabled: true,
          attachmentsEnabled: false,
        },
      ],
    };
  }

  private trailsLayerData(trailClassPickListId: string): DataLayerDataV3 {
    const fields: FeatureField[] = [
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        nullable: false,
        searchable: true,
      },
      {
        name: 'trail_class',
        type: 'string',
        label: 'Trail class',
        nullable: true,
        domain: {
          type: 'coded-value-ref',
          pickListItemId: trailClassPickListId,
        },
      },
      {
        name: 'length_mi',
        type: 'number',
        label: 'Length (miles)',
        nullable: true,
      },
    ];
    return {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: TRAILS_SUBLAYER,
          label: 'Trails',
          name: TRAILS_SUBLAYER,
          geometryType: 'line',
          fields,
          editingEnabled: true,
          attachmentsEnabled: false,
        },
      ],
    };
  }

  private parksLayerData(): DataLayerDataV3 {
    const fields: FeatureField[] = [
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        nullable: false,
        searchable: true,
      },
      { name: 'acres', type: 'number', label: 'Acres', nullable: true },
      {
        name: 'managed_by',
        type: 'string',
        label: 'Managed by',
        nullable: true,
      },
    ];
    return {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: PARKS_SUBLAYER,
          label: 'Parks and public lands',
          name: PARKS_SUBLAYER,
          geometryType: 'polygon',
          fields,
          editingEnabled: true,
          attachmentsEnabled: false,
        },
      ],
    };
  }

  private parcelsLayerData(): DataLayerDataV3 {
    const fields: FeatureField[] = [
      {
        name: 'label',
        type: 'string',
        label: 'Parcel',
        nullable: true,
        searchable: true,
      },
      {
        name: 'owner',
        type: 'string',
        label: 'Owner',
        nullable: true,
        searchable: true,
      },
      {
        name: 'address',
        type: 'string',
        label: 'Physical address',
        nullable: true,
        searchable: true,
      },
      { name: 'acres', type: 'number', label: 'Acres', nullable: true },
      {
        name: 'district',
        type: 'string',
        label: 'Tax district',
        nullable: true,
      },
    ];
    return {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: PARCELS_SUBLAYER,
          label: 'Parcels',
          name: PARCELS_SUBLAYER,
          geometryType: 'polygon',
          fields,
          // Reference cadastre: read-only in the sample so the demo
          // does not invite edits to 24k authoritative parcels.
          editingEnabled: false,
          attachmentsEnabled: false,
        },
      ],
    };
  }

  /**
   * One fully-populated MapLayer. Everything not explicitly styled
   * rides the shared defaults; the defaults are spread into fresh
   * objects because MapData is persisted as JSON and must never
   * alias the module-level constants.
   */
  private mapLayer(args: {
    id: string;
    title: string;
    itemId: string;
    layerKey: string;
    pointColor?: string;
    lineColor?: string;
    polygonColor?: string;
    searchFields?: string[];
    visible?: boolean;
  }): MapLayer {
    return {
      id: args.id,
      title: args.title,
      visible: args.visible ?? true,
      opacity: 1,
      source: { kind: 'data-layer', itemId: args.itemId, layerKey: args.layerKey },
      style: {
        point: {
          ...DEFAULT_LAYER_STYLE.point,
          ...(args.pointColor ? { color: args.pointColor } : {}),
        },
        line: {
          ...DEFAULT_LAYER_STYLE.line,
          ...(args.lineColor ? { color: args.lineColor } : {}),
        },
        polygon: {
          ...DEFAULT_LAYER_STYLE.polygon,
          ...(args.polygonColor
            ? { fillColor: args.polygonColor, strokeColor: args.polygonColor }
            : {}),
        },
      },
      renderer: { kind: 'simple' },
      popup: { ...DEFAULT_LAYER_POPUP },
      interactions: { ...DEFAULT_LAYER_INTERACTIONS },
      labels: { ...DEFAULT_LAYER_LABELS },
      search: args.searchFields
        ? { enabled: true, fields: args.searchFields, labelTemplate: '' }
        : { ...DEFAULT_LAYER_SEARCH },
      filter: null,
      scale: { ...DEFAULT_LAYER_SCALE },
      access: { ...DEFAULT_LAYER_ACCESS, entries: [] },
    };
  }

  private explorerMapData(
    facilitiesId: string,
    trailsId: string,
    parksId: string,
  ): MapData {
    return {
      version: 1,
      // Empty-string sentinel: ItemsService.create resolves it to the
      // org's default basemap item.
      basemap: '',
      center: [-79.847, 38.925],
      zoom: 10,
      bearing: 0,
      pitch: 0,
      // Index 0 renders on top: points over lines over polygons.
      layers: [
        this.mapLayer({
          id: 'facilities',
          title: 'County facilities',
          itemId: facilitiesId,
          layerKey: FACILITIES_SUBLAYER,
          pointColor: FACILITIES_COLOR,
          searchFields: ['name'],
        }),
        this.mapLayer({
          id: 'trails',
          title: 'Trails',
          itemId: trailsId,
          layerKey: TRAILS_SUBLAYER,
          lineColor: TRAILS_COLOR,
          searchFields: ['name'],
        }),
        this.mapLayer({
          id: 'parks',
          title: 'Parks and public lands',
          itemId: parksId,
          layerKey: PARKS_SUBLAYER,
          polygonColor: PARKS_COLOR,
          searchFields: ['name'],
        }),
      ],
      search: { enabled: true, geocoding: true },
    };
  }

  private parcelsMapData(parcelsId: string): MapData {
    return {
      version: 1,
      basemap: '',
      // Tight on Elkins so individual parcels are legible on open;
      // the whole county at low zoom is an undifferentiated mass.
      center: [-79.847, 38.925],
      zoom: 13,
      bearing: 0,
      pitch: 0,
      layers: [
        this.mapLayer({
          id: 'parcels',
          title: 'Parcels',
          itemId: parcelsId,
          layerKey: PARCELS_SUBLAYER,
          polygonColor: PARCELS_COLOR,
          searchFields: ['owner'],
        }),
      ],
      search: { enabled: true, geocoding: true },
    };
  }

  private fieldMapData(
    facilitiesId: string,
    reportsLayerItemId: string,
    reportsLayerKey: string,
  ): MapData {
    return {
      version: 1,
      basemap: '',
      // Centered on the Tygart Valley between Elkins and Huttonsville
      // so the seeded issue reports and the valley facilities frame.
      center: [-79.89, 38.84],
      zoom: 10,
      bearing: 0,
      pitch: 0,
      layers: [
        this.mapLayer({
          id: 'issue-reports',
          title: 'Issue reports',
          itemId: reportsLayerItemId,
          layerKey: reportsLayerKey,
          pointColor: REPORTS_COLOR,
        }),
        this.mapLayer({
          id: 'facilities',
          title: 'County facilities',
          itemId: facilitiesId,
          layerKey: FACILITIES_SUBLAYER,
          pointColor: FACILITIES_COLOR,
          searchFields: ['name'],
        }),
      ],
      search: { enabled: true, geocoding: true },
    };
  }

  private emergencyDerivedLayerData(facilitiesId: string): DerivedLayerData {
    return {
      version: 1,
      source: {
        kind: 'data_layer',
        itemId: facilitiesId,
        layerKey: FACILITIES_SUBLAYER,
      },
      pipeline: [
        {
          tool: 'filter',
          params: {
            // The recipe expression grammar has no IN operator; the
            // OR-chain is the supported spelling of a membership test.
            expression:
              "{{type}} == 'fire' OR {{type}} == 'ems' OR {{type}} == 'hospital'",
          },
        },
      ],
      featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
      // Recomputed server-side by validateAndEnrich at create time.
      outputSchema: [],
      bbox: [],
    };
  }

  private issueReportFormSchema(): FormSchema {
    const questions: Question[] = [
      {
        id: 'location',
        type: 'geopoint',
        label: 'Where is the issue?',
        hint: 'Use your GPS position or tap the map.',
        required: true,
        capture: 'auto',
      },
      {
        id: 'issue_type',
        type: 'select-one',
        label: 'Issue type',
        required: true,
        choices: ISSUE_TYPE_CHOICES.map((c) => ({ ...c })),
      },
      {
        id: 'severity',
        type: 'select-one',
        label: 'Severity',
        required: true,
        choices: SEVERITY_CHOICES.map((c) => ({ ...c })),
      },
      {
        id: 'description',
        type: 'multiline',
        label: 'Description',
        hint: 'What did you find, and where exactly?',
        required: true,
        rows: 3,
      },
      {
        id: 'reporter',
        type: 'text',
        label: 'Reporter name',
        hint: 'So the road crew can follow up.',
      },
    ];
    return {
      schemaVersion: 1,
      // Backfilled to the item id right after create; the id does not
      // exist yet when this payload is built.
      id: '',
      title: 'Road and trail issue report',
      description:
        'Report washouts, downed trees, potholes, and missing signage on county roads and trails.',
      questions,
      geometryQuestionId: 'location',
    };
  }

  /** Typed columns the paired submissions layer gains, mirroring what
   *  the designer's questionToFeatureField emits for these question
   *  types (geopoint maps to the geometry column, not a field). */
  private issueFormLayerFields(): FeatureField[] {
    return [
      {
        name: 'issue_type',
        type: 'string',
        label: 'Issue type',
        nullable: true,
        domain: {
          type: 'coded-value',
          values: ISSUE_TYPE_CHOICES.map((c) => ({
            code: c.value,
            label: c.label,
          })),
        },
      },
      {
        name: 'severity',
        type: 'string',
        label: 'Severity',
        nullable: true,
        domain: {
          type: 'coded-value',
          values: SEVERITY_CHOICES.map((c) => ({
            code: c.value,
            label: c.label,
          })),
        },
      },
      {
        name: 'description',
        type: 'string',
        label: 'Description',
        nullable: true,
      },
      {
        name: 'reporter',
        type: 'string',
        label: 'Reporter name',
        nullable: true,
      },
    ];
  }

  private viewerAppData(mapId: string, facilitiesId: string): WebAppData {
    const viewer: ViewerData = {
      version: 1,
      mapId,
      targets: [{ dataLayerId: facilitiesId, layerKey: FACILITIES_SUBLAYER }],
      tools: [...DEFAULT_VIEWER_TOOLS],
    };
    return {
      version: 1,
      template: 'viewer',
      config: { template: 'viewer', viewer },
    };
  }

  private explorerAppData(mapId: string, facilitiesId: string): WebAppData {
    const starter = STARTERS.find((s) => s.kind === 'sidebar-explorer');
    if (!starter) {
      // STARTERS is a compile-time constant; missing means the starter
      // was renamed without updating this reference.
      throw new Error(
        'sidebar-explorer starter is missing from STARTERS; sample app cannot be stamped',
      );
    }
    const custom = starter.seed();
    custom.mapId = mapId;
    custom.targets = [
      { dataLayerId: facilitiesId, layerKey: FACILITIES_SUBLAYER },
    ];
    return {
      version: 1,
      template: 'custom',
      config: { template: 'custom', custom },
    };
  }
}
