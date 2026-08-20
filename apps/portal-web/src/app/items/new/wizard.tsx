// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import {
  useCallback,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  ClipboardList,
  ExternalLink,
  FileText,
  FlaskConical,
  Folder as FolderIcon,
  Globe,
  Globe2,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  Map as MapIcon,
  MapPin,
  Mountain,
  Palette,
  Plug,
  Printer,
  Search,
  Sparkles,
  TerminalSquare,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import type {
  ArcgisServiceData,
  BasemapData,
  DataCollectionData,
  DataLayerDataV3,
  DerivedLayerData,
  FileData,
  ISODateString,
  Item,
  ItemAccess,
  ItemType,
  ServiceData,
  WebAppData,
  WmsServiceData,
  WfsServiceData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_BASEMAP,
  DEFAULT_DATA_LAYER_V3,
  DEFAULT_DERIVED_LAYER,
  DEFAULT_GEO_BOUNDARY,
  DEFAULT_PICK_LIST,
  DEFAULT_GEOCODING_SERVICE,
  DEFAULT_PRINT_TEMPLATE,
  emptyToolData,
  DEFAULT_TILE_LAYER,
  DEFAULT_POINT_CLOUD,
  DEFAULT_MAP,
  DEFAULT_FOLDER,
  DEFAULT_EDITOR,
  DEFAULT_VIEWER,
  ITEM_TYPES,
  APP_THEMES,
  getAppTemplate,
  serviceProtocolLabel,
  stampBlueprint,
} from '@gratis-gis/shared-types';
import type {
  AppTemplateId,
  CustomAppData,
} from '@gratis-gis/shared-types';
import { ThumbnailDesigner } from '@/components/thumbnail-designer';
import {
  defaultThumbnailDesign,
  type ThumbnailDesign,
} from '@gratis-gis/shared-types';
import {
  describeArcgisService,
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';
import {
  probeWms,
  probeWfs,
  type OgcCapabilities,
} from '@/lib/ogc-rest';
import {
  probeService as autoProbeService,
  type ServiceProbeResult,
} from '@/lib/service-probe';
import { DataCollectionBuilder } from './data-collection-builder';
import { PostgisConnectionBuilder } from './postgis-connection-builder';
import { BasemapConfigSection } from '../_components/basemap-config-section';
import {
  DataLayerBuilder,
  type PendingFileImport,
} from './data-layer-builder';
import { DerivedLayerBuilder } from './derived-layer-builder';
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
  /**
   * Picker value. Most options match an actual ItemType. A small set
   * of wizard-only sentinels (e.g. 'viewer' in #259) get remapped to
   * web_app + a template tag at submit time so the storage model
   * stays collapsed while the picker keeps Esri-friendly names.
   */
  value: ItemType | 'viewer' | 'custom' | 'postgis_connection';
  label: string;
  desc: string;
  Icon: LucideIcon;
}

// Item types live in five functional groups (#75): Data, Maps, Apps,
// Analysis, Organize. Within each group items are alphabetical so a
// returning user can run their eye to a known option without hunting.
// Group order follows the typical user journey: load data, make a
// map, build apps over it, analyze, then organize.
interface TypeGroup {
  label: string;
  options: TypeOption[];
  /**
   * Tailwind class fragment driving the per-group icon tile color
   * used in the new-item wizard cards. User feedback: every type
   * card used the portal's single accent color regardless of
   * category, making it hard to scan which group a card belonged
   * to at a glance. Each group now gets its own hue:
   *
   *   - Data    : sky blue        (raw sources)
   *   - Maps    : emerald          (composed visualizations)
   *   - Apps    : amber            (interactive surfaces)
   *   - Analysis: violet           (computed derivatives)
   *   - Organize: slate            (structural / meta)
   *
   * The format is `bg-<color>-500/10 text-<color>-700` so the icon
   * sits on a tinted tile that matches the rest of the portal's
   * card-with-icon vocabulary.
   */
  iconTileClass: string;
}

const TYPE_GROUPS: TypeGroup[] = [
  {
    label: 'Data',
    iconTileClass: 'bg-info/10 text-info',
    options: [
      {
        // Basemap lives under Data rather than Maps because it's a
        // remote-data pointer (tile URL / style.json / WMS endpoint)
        // that maps reference, just like Connected service or Data
        // layer. The original "Map = canvas, Basemap = also a kind
        // of map" framing mirrored Esri / AGO, but in GratisGIS's
        // model Map is the composition and Basemap is one of the
        // data sources composed -- the same category as the other
        // referenced layer types.
        value: 'basemap',
        label: 'Basemap',
        desc: 'A reusable background layer (style URL, tile template, or WMS) for maps.',
        Icon: Globe,
      },
      {
        value: 'geo_boundary',
        label: 'Boundary',
        desc: 'A named region (polygon) reused across shares, maps, and filters.',
        Icon: MapIcon,
      },
      {
        // #304: unified Connected Service replaces the four
        // protocol-specific tiles (ArcGIS service, WMS service,
        // WFS service, and the not-yet-shipped WMTS). One tile,
        // auto-detect probe -- the wizard figures out the protocol
        // from the URL response so the user doesn't have to know
        // upfront whether they're pointing at a MapServer, a WMS,
        // or a WMTS endpoint.
        value: 'service',
        label: 'Connected service',
        desc: 'Live pointer at an external service. Paste a URL; we recognize ArcGIS REST, WMS, WFS, and WMTS.',
        Icon: Plug,
      },
      {
        // #158 PostGIS live-read. UI-only wizard value; the
        // backend creates a normal `service` item with
        // `protocol: 'postgis_live'` via the single-shot
        // /postgis-live/create endpoint. The builder handles its
        // own save + redirect; the wizard's generic save flow is
        // skipped when this type is selected.
        value: 'postgis_connection',
        label: 'PostgreSQL + PostGIS (live)',
        desc: 'Connect to a live PostgreSQL + PostGIS database. Maps read tables on demand by bounding box; no data is copied into the portal.',
        Icon: Plug,
      },
      {
        value: 'data_layer',
        label: 'Data layer',
        desc: 'A shareable vector layer backed by PostGIS.',
        Icon: Layers,
      },
      {
        value: 'file',
        label: 'File',
        desc: 'Any uploaded file (PDF, image, zip, etc.).',
        Icon: FileText,
      },
      {
        // #74: geocoding_service. Wraps a data_layer + chosen
        // search fields and exposes a /geocode endpoint for maps
        // and apps to use as a search source.
        value: 'geocoding_service',
        label: 'Geocoding service',
        desc: 'Searchable index over a data layer. Lets maps and apps geocode against your own parcels, addresses, or places.',
        Icon: MapPin,
      },
      {
        value: 'pick_list',
        label: 'Pick list',
        desc: 'Shared list of codes + labels referenced by fields, forms, and filters.',
        Icon: ListChecks,
      },
      {
        // #179: tile_layer. Wraps a pre-rendered PMTiles file
        // (single .pmtiles upload) and exposes it as a tile
        // service consumable as a basemap. Sibling to Basemap
        // because both back map rendering, but Tile layer is
        // "I have the cache, just host it" while Basemap is
        // "I have the URL or service, point at it."
        value: 'tile_layer',
        label: 'Tile layer',
        desc: 'Upload a pre-rendered tile cache (PMTiles, MBTiles, or zipped XYZ tile directory). Hosts the file and exposes a tile URL maps can use as a basemap.',
        Icon: Layers,
      },
      {
        // #179 (3D as layers): point_cloud wraps one COPC lidar
        // file. Sibling to Tile layer: both are "host my
        // range-readable file" items; this one streams 3D points
        // instead of tiles.
        value: 'point_cloud',
        label: 'Point cloud',
        desc: 'Upload lidar as COPC (.copc.laz). Hosts the file and streams points by viewport for 3D viewing.',
        Icon: Mountain,
      },
    ],
  },
  {
    label: 'Maps',
    iconTileClass: 'bg-success/10 text-success',
    options: [
      {
        value: 'map',
        label: 'Map',
        desc: 'A basemap with overlay layers and styling.',
        Icon: MapIcon,
      },
    ],
  },
  {
    label: 'Apps',
    iconTileClass: 'bg-warn/10 text-warn',
    options: [
      // #22: Dashboard / Editor / Viewer pulled from the picker.
      // Editor and Viewer are just specific layouts of the same
      // Custom Web App framework, so they live as app_template
      // items now (seeded per org alongside Sidebar Explorer
      // etc.); the picker only needs the one "Custom web app"
      // entry, and the wizard's template gallery is where users
      // pick the editor / viewer / parcel / dashboard layout.
      //
      // Dashboards are the same story: the KPI Dashboard and
      // Operations Board starters are app_template items, so a
      // dashboard is a custom web app that starts from a dashboard
      // layout. There is deliberately no `dashboard` entry here and
      // no dashboard item type to create; the placeholder enum value
      // survives only so any pre-existing row still resolves.
      {
        value: 'form',
        label: 'Form',
        desc: 'A collection form for fieldwork or survey data. Submissions land in a paired data layer; the form\'s Responses tab shows every submission on a map.',
        Icon: FileText,
      },
      {
        value: 'data_collection',
        label: 'Data collection',
        desc: 'Field-mode deployment: tap features on a map to add or edit them. Forms come from the layer schema by default.',
        Icon: ClipboardList,
      },
      // No 'report_template' tile. There is no report_template
      // editor, so picking it produced a titled item permanently
      // parked on the coming-soon page. Same reason 'dashboard' is
      // not offered here.
      {
        value: 'custom',
        label: 'Web app',
        desc: 'Drag-drop layout of map + tool widgets, sidebar, header, foldable groups. Pick a starter template (Sidebar Explorer, Showcase Map, Editor, Viewer, etc.) on the next screen, or start blank and build the layout from scratch.',
        Icon: Sparkles,
      },
      {
        // #54: themes are items.  Starts a blank theme cloned
        // from the Default starter so the user lands in the
        // theme editor with a working palette to tweak.
        value: 'theme',
        label: 'Theme',
        desc: 'Reusable color palette + geometry tokens applied to web apps. Edit the colors and a live preview shell shows where each one appears.',
        Icon: Palette,
      },
      {
        // #101: print templates are items.  Starts a blank
        // template on a Letter portrait canvas so the user lands
        // in the print-template designer ready to drop elements.
        value: 'print_template',
        label: 'Print template',
        desc: 'Layout for the Print tool in a web app: paper size, title block, map frame, legend, scalebar, north arrow. Drag elements onto a paper-sized canvas, declare parameters the print form prompts for, save.',
        Icon: Printer,
      },
      {
        // #90: tool items.  Reusable named action (open a URL,
        // jump to another item) that a Custom Web App Button widget
        // can bind to.  The same tool used across multiple apps
        // keeps the recipe centralized -- update the URL once and
        // every button pointing at it follows.
        value: 'tool',
        label: 'Tool',
        desc: 'A reusable named action - "open this dashboard" or "go to this URL" - that you bind to a Button on a Custom Web App. One tool can be reused across many apps, so updating the destination once propagates everywhere.',
        Icon: Wand2,
      },
    ],
  },
  {
    label: 'Analysis',
    iconTileClass: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
    options: [
      {
        value: 'derived_layer',
        label: 'Derived layer',
        desc: 'A layer computed live from another, with tools like buffer.',
        Icon: FlaskConical,
      },
      {
        // #221. Filtered out below unless the portal has scripts
        // switched on, because on a portal without a script runner
        // this would create an item nothing can execute.
        value: 'script',
        label: 'Script',
        desc: 'Your own Python, run on the server. Write it in your usual editor, paste it here, and the portal runs it with your permissions - useful for the maintenance jobs a laptop cannot do because it is closed at 3am.',
        Icon: TerminalSquare,
      },
    ],
  },
  {
    label: 'Organize',
    iconTileClass: 'bg-surface-2 text-ink-1',
    options: [
      {
        value: 'folder',
        label: 'Folder',
        desc: 'A curated grouping of items. Sharing a folder shares the arrangement; per-item access still applies.',
        Icon: FolderIcon,
      },
    ],
  },
];

// Flat fallback used by everything-else-on-the-page (the picked-type
// summary header on step 2, etc.) so we keep the grouped picker
// the single source of label/desc/icon truth.
const TYPE_OPTIONS: TypeOption[] = TYPE_GROUPS.flatMap((g) => g.options);

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

/**
 * #22: summary of one app_template item, served from the server
 * component and used by the Custom Web App gallery.  The full
 * blueprint is fetched at submit time so we don't ship every
 * widget tree on every wizard mount.
 */
export interface AppTemplateSummary {
  itemId: string;
  title: string;
  description: string;
  tags: string[];
}

export function NewItemWizard({
  appTemplates = [],
  scriptsEnabled = false,
}: {
  appTemplates?: AppTemplateSummary[];
  /** #221: portal-info features.feedback's sibling. Offering "Script"
   *  on a portal with no runner would create an item that can never
   *  execute, which is worse than not offering it. */
  scriptsEnabled?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Optional `?type=<itemType>` query param lets entry points like the
  // folder rail's "Create one" link, the FolderDetail "+ New
  // subfolder" button, and any future deep-link skip the picker step
  // and land directly on the details form. Validated against the
  // known ItemType set so a stray param can't put the wizard in a
  // bogus state.
  // Accept either a real ItemType OR one of the wizard sentinels
  // ('viewer', 'custom') so deep-links like "Use this template"
  // (?type=custom&template=<id>) can skip the picker.  The legacy
  // 'survey' sentinel was retired in #91 (folded onto Form).
  const querySentinel = (
    ['viewer', 'custom'] as const
  ).find((s) => s === (searchParams?.get('type') ?? ''));
  const queryType: ItemType | 'viewer' | 'custom' | null =
    querySentinel
      ? querySentinel
      : searchParams &&
          (ITEM_TYPES as readonly string[]).includes(
            searchParams.get('type') ?? '',
          )
        ? (searchParams.get('type') as ItemType)
        : null;
  const [step, setStep] = useState<Step>(queryType ? 'details' : 'pick');
  // #259: 'viewer' is a wizard-only sentinel that maps to web_app +
  // template='viewer' at submit time. It isn't a persisted ItemType
  // (the picker stays an Esri-friendly noun while the storage stays
  // collapsed under web_app templates).
  // #158 adds 'postgis_connection' as a UI-only pseudo-type. The
  // resulting item is a normal `service` with protocol='postgis_live';
  // the pseudo-type just routes the wizard to the PostgisConnectionBuilder
  // pane and skips the generic Create button (the builder owns its own
  // save flow because /postgis-live/create is a single shot).
  const [type, setType] = useState<
    ItemType | 'viewer' | 'custom' | 'postgis_connection' | null
  >(queryType);

  // Metadata persists across back/forward between steps so the user
  // doesn't lose typed input when they pop back to change type.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [access, setAccess] = useState<ItemAccess>('private');
  // thumbnailUrl is retained at null so the create payload's shape
  // stays back-compat with the API; uploads are no longer offered
  // in the wizard now that ThumbnailDesigner is the single thumbnail
  // surface (#66).
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  void setThumbnailUrl;
  // #66: auto-thumbnail design state. Resolves the wizard's
  // wider-than-ItemType union (viewer/custom both bake to web_app
  // under the hood) to a concrete type for the designer.  Author
  // can tweak colors before saving; absent customization, we let
  // the backend apply its own type-default on create.
  const resolvedTypeForThumbnail: ItemType =
    type === 'viewer' || type === 'custom'
      ? 'web_app'
      : type === 'postgis_connection'
        ? 'service'
        : (type ?? 'file');
  const [thumbnailDesign, setThumbnailDesign] = useState<ThumbnailDesign>(() =>
    defaultThumbnailDesign(resolvedTypeForThumbnail),
  );

  // Custom Web App template selection.  Templates are app_template
  // items the user has read access to; the wizard fetches the list
  // server-side and passes it in via props.  We track the chosen
  // item id (or null = "no template, start blank").  On submit,
  // the item's CustomAppData blueprint is fetched and stamped with
  // fresh widget ids; falls back to a Blank Canvas equivalent if
  // there are no templates available (e.g. admin deleted all
  // starters and hasn't restored them yet).
  // Preselect via ?template=<itemId> when the user followed
  // "Use this template" from a template detail page; otherwise
  // default to the first available template (typically the
  // alphabetically-first built-in starter).
  const preselectedTemplateId =
    searchParams?.get('template') ?? null;
  const [customAppTemplateItemId, setCustomAppTemplateItemId] = useState<
    string | null
  >(
    preselectedTemplateId && appTemplates.some((t) => t.itemId === preselectedTemplateId)
      ? preselectedTemplateId
      : (appTemplates[0]?.itemId ?? null),
  );
  // Legacy state kept around in case some unrelated code reads the
  // old AppTemplateId.  No longer driven by the gallery.
  const [customAppTemplateId, setCustomAppTemplateId] =
    useState<AppTemplateId>('sidebar-explorer');
  void customAppTemplateId;
  void setCustomAppTemplateId;

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

  // Credential bootstrap (#74). When the anonymous probe gets a
  // 401 / 403 / 499 / "Token Required" we surface the credential
  // form inline instead of failing the wizard. The form drives the
  // probe-with-credential endpoint server-side, then on Create we
  // store the same credential payload against the freshly-created
  // item id so the proxy works without any further setup. The
  // credential plaintext lives in this component for the duration
  // of the wizard only.
  type WizardCredential =
    | { kind: 'arcgis_token'; token: string }
    | { kind: 'bearer'; token: string }
    | { kind: 'basic'; username: string; password: string };
  const [needsAuth, setNeedsAuth] = useState(false);
  // Default is Basic (username + password): it's how ArcGIS Online
  // exposes per-user auth and the most common shape we'll see.
  // The probe endpoint exchanges Basic for a token under the hood
  // for ArcGIS REST URLs so the upstream call goes out as a real
  // token-bearing request (AGO does not honour HTTP Basic). (#76)
  const [credentialKind, setCredentialKind] = useState<
    'arcgis_token' | 'bearer' | 'basic'
  >('basic');
  const [credentialToken, setCredentialToken] = useState('');
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  // Set once a probe-with-credential succeeds. On Create we POST
  // this to PUT /api/items/:newId/credential so the new item is
  // immediately useable through the proxy.
  const [pendingCredential, setPendingCredential] =
    useState<WizardCredential | null>(null);

  // Feature-service builder state. Stays in v3 shape from the start so
  // the POST body can be sent as-is.
  const [featureServiceData, setDataLayerData] =
    useState<DataLayerDataV3>(DEFAULT_DATA_LAYER_V3);

  // Derived-layer builder state. The recipe (source + pipeline) is
  // structural so the wizard collects it up front rather than starting
  // with an empty scaffold the user fills in on the detail page.
  // #82: pre-seed source from ?source=<itemId> when the user
  // followed the "Derive..." link from a data_layer detail page.
  // The DerivedLayerBuilder reads source.itemId on mount and resolves
  // the rest (sublayer picker, schema fetch) automatically; passing
  // a non-empty itemId is enough to land them in "source already
  // picked, configure pipeline" state.
  const preseededDerivedSourceId = searchParams?.get('source') ?? null;
  const [derivedLayerData, setDerivedLayerData] = useState<DerivedLayerData>(
    () =>
      preseededDerivedSourceId
        ? {
            ...DEFAULT_DERIVED_LAYER,
            source: { kind: 'data_layer', itemId: preseededDerivedSourceId },
          }
        : DEFAULT_DERIVED_LAYER,
  );

  // data_collection wizard state: just the chosen map id. mapId is
  // required at create-time (no map = nothing to deploy), and there's
  // no "configure later" because the rest of the data_collection (form
  // bindings, offline config) is purely additive on the detail page.
  // Field Maps Slice 1 (#141).
  const [dataCollectionMapId, setDataCollectionMapId] = useState<string | null>(
    null,
  );

  // #296: file item upload state. The wizard does the presign + PUT
  // up front so the item is fully populated on create -- no "create
  // empty, then upload" two-step. Null until the user picks a file
  // and the upload completes; submit() blocks on it.
  const [fileItemUpload, setFileItemUpload] = useState<FileData | null>(null);

  // Pending file ingests for data_layer create. The DataLayerBuilder
  // calls /ingest/stage when the user uploads a multi-layer file
  // (GDB, shapefile-zip, GeoPackage); the server keeps the bytes
  // under /tmp/gg-staging/<id>/ and we hold the stagingId here so
  // submit() can fan out POST /items/:id/layers/:layerId/import
  // for each detected layer AFTER the item is created. Cleared on
  // type switch so a half-typed wizard doesn't carry a stale
  // staging across to a different item type.
  const [pendingFileImports, setPendingFileImports] = useState<
    PendingFileImport[]
  >([]);

  // #115: when one or more per-layer import-job enqueues fail, hold
  // the user on the wizard so they can read the inline error banner
  // before navigating. The actual import is async (worker drains the
  // import_job table; detail-page banner reports progress); only the
  // ENQUEUE failures surface here. Stores the URL we WOULD have
  // navigated to so the inline Continue button lands them on the
  // right page.
  const [ingestNavTarget, setIngestNavTarget] = useState<string | null>(
    null,
  );

  // #298: basemap draft state. Captured up front so the wizard
  // writes a fully-configured item (kind + URL + WMS layer list)
  // instead of an empty placeholder. The shape mirrors BasemapData;
  // only fields matching the active kind are meaningful.
  const [basemapDraft, setBasemapDraft] = useState<BasemapData>(DEFAULT_BASEMAP);

  // #304 slice 3: unified Connected Service probe state. Replaces
  // the legacy per-protocol probe state for new items going
  // forward (the legacy state below stays for the deprecation
  // window in case a deep-link or migration script hits a legacy
  // type). Auto-detect probe lives in lib/service-probe.ts; the
  // wizard just stores the result and feeds it to submit() as a
  // ServiceData payload.
  const [serviceUrlDraft, setServiceUrlDraft] = useState<string>('');
  const [serviceProbing, setServiceProbing] = useState(false);
  const [serviceProbeError, setServiceProbeError] = useState<string | null>(null);
  const [serviceProbeResult, setServiceProbeResult] =
    useState<ServiceProbeResult | null>(null);
  const [serviceSelectedLayerNames, setServiceSelectedLayerNames] =
    useState<Set<string>>(new Set());

  // #297: WMS / WFS probe state. Mirrors the ArcGIS probe flow but
  // simpler -- no auth path yet (most public WMS / WFS endpoints are
  // anonymous) and the layer ids are strings, not numbers. The probe
  // result is shaped as OgcCapabilities so the same branch handles
  // both protocols; submit() reads the kind off the result.
  const [ogcUrlDraft, setOgcUrlDraft] = useState<string>('');
  const [ogcProbing, setOgcProbing] = useState(false);
  const [ogcProbeError, setOgcProbeError] = useState<string | null>(null);
  const [ogcProbeResult, setOgcProbeResult] = useState<OgcCapabilities | null>(
    null,
  );
  const [ogcSelectedLayerNames, setOgcSelectedLayerNames] = useState<Set<string>>(
    new Set(),
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pickType = useCallback(
    (t: ItemType | 'viewer' | 'custom' | 'postgis_connection') => {
      setType(t);
      setStep('details');
      setError(null);
    },
    [],
  );

  const backToPicker = useCallback(() => {
    setStep('pick');
    setError(null);
  }, []);

  /**
   * Spread a probe result into the wizard's UI state. Shared by
   * the anonymous and credential-aware probe paths so they stay
   * in lockstep on auto-fill / default-pick / select-all logic.
   */
  const applyProbeResult = useCallback(
    (desc: ArcgisServiceDescription) => {
      // The legacy arcgis_service wizard branch wraps Map / Feature
      // services only. A GeocodeServer URL is handled by the
      // unified `service` item type's auto-probe (#75) instead;
      // refuse it here so we never seed an arcgis_service item
      // with a serviceType the runtime can't render.
      if (desc.serviceType === 'GeocodeServer') {
        setError(
          'This URL points at an ArcGIS GeocodeServer. Switch to the Connected service type to create a geocoder item.',
        );
        return;
      }
      setArcgisProbeResult(desc);
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
      const firstGeom = desc.layers.find((l) => l.geometryType);
      const pick = firstGeom?.id ?? desc.layers[0]?.id ?? null;
      setArcgisDefaultLayerId(pick);
      setArcgisSelectedLayerIds(new Set(desc.layers.map((l) => l.id)));
    },
    [title, description],
  );

  /**
   * Recognise the upstream "needs auth" signal across the various
   * shapes ArcGIS / WMS / WFS use. ArcGIS can either emit a real
   * 401/403 or a 200 envelope with code 498/499. WMS/WFS usually
   * just 401. We fold them all into the same UX path.
   */
  function isAuthError(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /\b(401|403|498|499)\b/.test(msg) ||
      /token\s*required/i.test(msg) ||
      /not\s*authorized/i.test(msg) ||
      /unauthor/i.test(msg)
    );
  }

  const runArcgisProbe = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    setNeedsAuth(false);
    setPendingCredential(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const desc = await probeService(raw, controller.signal);
      if (controller.signal.aborted) return;
      applyProbeResult(desc);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      // Auth-shaped failure: switch to the credential form instead
      // of giving up. The user fills it in and we re-probe through
      // the server-side endpoint. (#74)
      if (isAuthError(err)) {
        setNeedsAuth(true);
        setError(
          'This service requires authentication. Pick a credential type and provide the secret to continue.',
        );
        return;
      }
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [arcgisUrlDraft, applyProbeResult]);

  /**
   * #304 slice 3: unified Connected Service probe runner. Hits
   * lib/service-probe.ts which auto-detects ArcGIS REST / WMS /
   * WFS / WMTS, then stages the resulting ServiceData on
   * serviceProbeResult so the rest of the wizard can render the
   * picker + submit. Selects every probed layer by default so a
   * "probe -> Create" flow yields a complete item without picker
   * interaction; the user only touches the picker to curate.
   */
  const runServiceProbe = useCallback(async () => {
    const raw = serviceUrlDraft.trim();
    if (!raw) {
      setServiceProbeError('Paste a service URL.');
      return;
    }
    setServiceProbeError(null);
    setServiceProbing(true);
    try {
      const result = await autoProbeService(raw);
      // Geocoders aren't viewable through the Connected Service item
      // type; they're queried, not rendered as layers. The unified
      // Geocoding Service item type (internal data layer OR external
      // GeocodeServer URL) is where geocoder URLs live. Redirect the
      // user there so they don't end up with a half-functional
      // service item.
      if (result.data.protocol === 'arcgis_geocode') {
        setServiceProbeError(
          'That URL points at an ArcGIS GeocodeServer. Cancel this and create a Geocoding service item instead. In the Geocoding service editor, pick "Use an existing ArcGIS GeocodeServer" and paste this URL.',
        );
        setServiceProbeResult(null);
        setServiceSelectedLayerNames(new Set());
        return;
      }
      setServiceProbeResult(result);
      setServiceSelectedLayerNames(
        new Set(result.data.layers.map((l) => l.name)),
      );
    } catch (err) {
      setServiceProbeError(
        err instanceof Error
          ? err.message
          : 'Could not identify that service. Check the URL and CORS config.',
      );
      setServiceProbeResult(null);
      setServiceSelectedLayerNames(new Set());
    } finally {
      setServiceProbing(false);
    }
  }, [serviceUrlDraft]);

  /**
   * #297 OGC probe runner. Fires a GetCapabilities against the user-
   * supplied URL, parses the response, and lights up the layer picker.
   * Selects all layers by default so a "Probe -> Create" flow yields
   * a complete item without extra clicks. Selection is per-protocol
   * (WMS layer Name / WFS typeName) and stored as a string set.
   */
  const runOgcProbe = useCallback(async () => {
    const raw = ogcUrlDraft.trim();
    if (!raw) {
      setOgcProbeError(
        type === 'wfs_service'
          ? 'Paste a WFS endpoint URL (the GetCapabilities base, no query string).'
          : 'Paste a WMS endpoint URL (the GetCapabilities base, no query string).',
      );
      return;
    }
    setOgcProbeError(null);
    setOgcProbing(true);
    try {
      const result =
        type === 'wfs_service' ? await probeWfs(raw) : await probeWms(raw);
      setOgcProbeResult(result);
      setOgcSelectedLayerNames(new Set(result.layers.map((l) => l.name)));
    } catch (err) {
      setOgcProbeError(
        err instanceof Error
          ? err.message
          : 'Could not read that service. Check the URL and CORS config.',
      );
      setOgcProbeResult(null);
      setOgcSelectedLayerNames(new Set());
    } finally {
      setOgcProbing(false);
    }
  }, [ogcUrlDraft, type]);

  /**
   * Probe with a user-supplied credential via the server-side
   * /api/portal/services/probe endpoint. Same response shape as
   * the anonymous client probe so applyProbeResult reuses the
   * existing UI logic. Stashes the credential into pendingCredential
   * so we can save it against the new item id at Create time.
   */
  const runArcgisProbeWithCredential = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    let cred: WizardCredential;
    if (credentialKind === 'arcgis_token' || credentialKind === 'bearer') {
      const token = credentialToken.trim();
      if (!token) {
        setError('Token is required for this credential type.');
        return;
      }
      cred = { kind: credentialKind, token };
    } else {
      const u = credentialUsername.trim();
      const p = credentialPassword;
      if (!u || !p) {
        setError('Username and password are required for basic auth.');
        return;
      }
      cred = { kind: 'basic', username: u, password: p };
    }
    setError(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const res = await fetch('/api/portal/services/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: raw, credential: cred }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(
          `Probe failed: ${res.status}${text ? ` - ${text.slice(0, 200)}` : ''}`,
        );
        return;
      }
      const wrapped = (await res.json()) as {
        ok: boolean;
        status: number;
        statusText?: string;
        body?: unknown;
      };
      if (controller.signal.aborted) return;
      if (!wrapped.ok) {
        setError(
          wrapped.statusText ||
            `Upstream returned ${wrapped.status}. Check the credential and try again.`,
        );
        return;
      }
      // Re-shape the upstream JSON into the same ArcgisServiceDescription
      // the client probe produces. describeArcgisService is the
      // pure parser shared with probeService so the two paths stay
      // in lockstep on layer/table/bbox extraction.
      let desc: ArcgisServiceDescription;
      try {
        desc = await describeArcgisService(
          raw,
          wrapped.body,
          controller.signal,
        );
      } catch (parseErr) {
        setError(
          (parseErr as Error).message ||
            'Probe succeeded but the response did not look like an ArcGIS service.',
        );
        return;
      }
      applyProbeResult(desc);
      setPendingCredential(cred);
      setNeedsAuth(false);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not reach the probe endpoint. Try again in a moment.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [
    arcgisUrlDraft,
    credentialKind,
    credentialToken,
    credentialUsername,
    credentialPassword,
    applyProbeResult,
  ]);

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
        // applyProbeResult refuses GeocodeServer above, so any
        // probeResult that reaches this assignment is always
        // Map / Feature service. Narrow to keep the legacy
        // arcgis_service item type happy after ArcgisServiceType
        // grew GeocodeServer (#75).
        serviceType: arcgisProbeResult.serviceType as
          | 'MapServer'
          | 'FeatureServer',
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
        // requiresAuth flips on automatically when a credential was
        // used during probe. The credential payload is saved against
        // the new item id immediately after create (#74) so the proxy
        // works without further setup.
        requiresAuth: pendingCredential !== null,
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
      // #298: source-aware basemap authoring. The wizard collects the
      // source kind + the URL / WMS config the renderer needs so the
      // item lands fully configured. Empty kind/URL falls back to the
      // empty scaffold so a user can still create a placeholder and
      // fill it in on the detail page.
      if (basemapDraft && basemapDraft.kind) {
        if (basemapDraft.kind === 'tile-url' && !basemapDraft.tileUrl?.trim()) {
          setError('Tile URL is required (XYZ template like https://.../{z}/{x}/{y}.png).');
          return;
        }
        if (basemapDraft.kind === 'style-url' && !basemapDraft.styleUrl?.trim()) {
          setError('Style URL is required (a hosted style.json).');
          return;
        }
        if (basemapDraft.kind === 'wms') {
          if (!basemapDraft.wmsUrl?.trim()) {
            setError('WMS GetMap URL is required.');
            return;
          }
          if (!basemapDraft.wmsConfig?.layers?.trim()) {
            setError('At least one WMS layer name is required.');
            return;
          }
        }
        data = basemapDraft;
      } else {
        data = DEFAULT_BASEMAP;
      }
    } else if (type === 'wms_service' || type === 'wfs_service') {
      // #297: WMS / WFS items now ship with a probe-or-bail wizard
      // step. The picker writes a fully-configured item (URL, layer
      // list, selectedLayerIds defaulting to "all") so the detail
      // page lands ready-to-render. Same shape pattern as
      // arcgis_service.
      if (
        !ogcProbeResult ||
        ogcProbeResult.kind !== (type === 'wms_service' ? 'wms' : 'wfs')
      ) {
        setError(
          type === 'wfs_service'
            ? 'Probe the WFS service URL before creating the item.'
            : 'Probe the WMS service URL before creating the item.',
        );
        return;
      }
      if (ogcSelectedLayerNames.size === 0) {
        setError('Select at least one layer to include in this item.');
        return;
      }
      // selectedLayerIds is typed as number[] (predates the OGC
      // types). For OGC services we use the layer's index in the
      // probed list; the canonical name lives on layers[i].name.
      const ids: number[] = [];
      ogcProbeResult.layers.forEach((l, i) => {
        if (ogcSelectedLayerNames.has(l.name)) ids.push(i);
      });
      if (type === 'wms_service' && ogcProbeResult.kind === 'wms') {
        const wms: WmsServiceData = {
          version: 1,
          url: ogcProbeResult.url,
          protocolVersion: ogcProbeResult.protocolVersion,
          format: 'image/png',
          transparent: true,
          crs: 'EPSG:3857',
          layers: ogcProbeResult.layers.map((l) => {
            const out: WmsServiceData['layers'][number] = {
              name: l.name,
              title: l.title,
            };
            if (l.bbox) out.bbox = l.bbox;
            return out;
          }),
          selectedLayerIds: ids,
          ...(ogcProbeResult.bbox ? { bbox: ogcProbeResult.bbox } : {}),
          probedAt: new Date().toISOString() as ISODateString,
        };
        data = wms;
      } else if (type === 'wfs_service' && ogcProbeResult.kind === 'wfs') {
        const wfs: WfsServiceData = {
          version: 1,
          url: ogcProbeResult.url,
          protocolVersion: ogcProbeResult.protocolVersion,
          outputFormat: 'application/json',
          layers: ogcProbeResult.layers.map((l) => {
            const out: WfsServiceData['layers'][number] = {
              name: l.name,
              title: l.title,
            };
            if (l.bbox) out.bbox = l.bbox;
            return out;
          }),
          selectedLayerIds: ids,
          ...(ogcProbeResult.bbox ? { bbox: ogcProbeResult.bbox } : {}),
          probedAt: new Date().toISOString() as ISODateString,
        };
        data = wfs;
      }
    } else if (type === 'folder') {
      // Empty folder; the detail page handles adding children via the
      // "Add to folder" multi-select and drag-drop in Phase 1b.
      data = DEFAULT_FOLDER;
    } else if (type === 'editor') {
      // #258: new editor items go in as web_app + template='editor'
      // directly so we don't keep accumulating legacy `type='editor'`
      // rows during the deprecation window. The user-facing word
      // stays "Editor" (see the picker option above) but the persisted
      // shape is the consolidated WebAppData. readEditorData() unwraps
      // the nested EditorData on read; isEditorItem() identifies
      // these rows for routing and policy.
      //
      // The detail page handles target-layer configuration and
      // template authoring on top of an empty editor scaffold. The
      // runtime renders an empty-state prompt until the first target
      // is added. See docs/editing-and-collection.md.
      const webApp: WebAppData = {
        version: 1,
        template: 'editor',
        config: { template: 'editor', editor: DEFAULT_EDITOR },
      };
      data = webApp;
    } else if (type === 'viewer') {
      // #259: viewer items go in as web_app + template='viewer' from
      // day one (no legacy top-level type='viewer' to migrate from).
      // Same shape pattern as the editor branch above; the runtime
      // and detail-page dispatch unwrap via readViewerData /
      // isViewerItem. Empty targets + map; the detail page wires
      // those up post-create.
      const webApp: WebAppData = {
        version: 1,
        template: 'viewer',
        config: { template: 'viewer', viewer: DEFAULT_VIEWER },
      };
      data = webApp;
    } else if (type === 'custom') {
      // #22: Custom Web App seeded from a user-selected app_template
      // item.  Fetch the chosen template's blueprint, stamp fresh
      // widget ids via stampBlueprint, wrap as WebAppData.  If no
      // template was selected (org has none, or user dismissed the
      // gallery), fall back to the legacy built-in starter so
      // create always succeeds and lands on a working empty app.
      let blueprintData: CustomAppData;
      if (customAppTemplateItemId) {
        type TemplateItemResponse = { data: CustomAppData };
        const res = await fetch(
          `/api/portal/items/${customAppTemplateItemId}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          throw new Error(
            `Could not load the chosen template (HTTP ${res.status})`,
          );
        }
        const body = (await res.json()) as TemplateItemResponse;
        blueprintData = stampBlueprint(body.data);
      } else {
        // No template available (or none picked); fall back to the
        // built-in blank seed library so this branch always returns
        // a valid CustomAppData.
        blueprintData = getAppTemplate('blank-canvas').seed();
      }
      const webApp: WebAppData = {
        version: 1,
        template: 'custom',
        config: { template: 'custom', custom: blueprintData },
      };
      data = webApp;
    } else if (type === 'theme') {
      // #54: seed a fresh theme item from the Default starter's
      // tokens so the author lands on the theme editor with a
      // working palette to tweak.  The swatch follows the
      // accent color; both fields are editable on the detail
      // page.  Picker preview matches what the runtime applies.
      const def = APP_THEMES.default;
      data = {
        version: 1,
        swatch: def.swatch,
        tokens: def.tokens,
      };
    } else if (type === 'print_template') {
      // #101: seed a fresh print template on a Letter portrait
      // canvas with a single Title parameter and a blank element
      // list.  Author lands on the designer ready to drop
      // elements onto the page.
      //
      // #159: when the wizard was opened from a map's "Print
      // this map" button, the calling map id flows through as
      // a `?map=<uuid>` query param. Stamp it into the
      // template's `defaultMapId` field so the designer's Map /
      // Legend / Scalebar / North-arrow elements auto-bind to
      // the right map without the author having to wire
      // references manually.
      const mapHint = searchParams?.get('map') ?? null;
      data = mapHint
        ? { ...DEFAULT_PRINT_TEMPLATE, defaultMapId: mapHint }
        : DEFAULT_PRINT_TEMPLATE;
    } else if (type === 'tool') {
      // #90: seed an empty tool whose default action is "open URL"
      // with an empty URL.  Saves cleanly (the runtime treats an
      // empty URL as a no-op) and lands the author on the detail
      // page to configure the action.
      data = emptyToolData();
    } else if (type === 'point_cloud') {
      // #179: empty point_cloud. The COPC upload + header
      // validation happen on the detail page after create, same
      // as tile_layer.
      data = DEFAULT_POINT_CLOUD;
    } else if (type === 'tile_layer') {
      // #179: empty tile_layer. The file upload + metadata
      // extraction happen on the detail page after create,
      // mirroring how `file` items work today.
      data = DEFAULT_TILE_LAYER;
    } else if (type === 'geocoding_service') {
      // #74: empty geocoding_service. The detail page hosts the
      // source-layer + search-fields config (which fields to
      // search, weights, label template, bboxFilter). Creating
      // empty + configuring on the detail page mirrors how
      // pick_list and geo_boundary work; the wizard would
      // duplicate the editor surface for no gain.
      data = DEFAULT_GEOCODING_SERVICE;
    } else if (type === 'data_collection') {
      // mapId is structural: a data_collection without a map has
      // nothing for collectors to tap on. Block create until the
      // wizard's map picker has resolved a choice. Form bindings and
      // offline config stay defaulted-empty; the field-mode runtime
      // falls through to schema-derived forms (Field Maps default)
      // and online-only mode until an author opts in on the detail
      // page.
      if (!dataCollectionMapId) {
        setError('Pick a map for this data collection.');
        return;
      }
      const dc: DataCollectionData = {
        version: 1,
        mapId: dataCollectionMapId,
      };
      data = dc;
    } else if (type === 'service') {
      // #304 slice 3: unified Connected Service probe-or-bail.
      // The wizard requires a successful auto-detect probe so the
      // new item lands fully configured (URL, protocol, layer
      // list, default selection). Selection by name makes re-
      // probe later resilient to layer reorderings.
      if (!serviceProbeResult) {
        setError('Probe the service URL before creating the item.');
        return;
      }
      if (serviceSelectedLayerNames.size === 0) {
        setError('Select at least one layer to include in this item.');
        return;
      }
      const probedData = serviceProbeResult.data;
      const ids: number[] = [];
      probedData.layers.forEach((l, i) => {
        if (serviceSelectedLayerNames.has(l.name)) ids.push(i);
      });
      const payload: ServiceData = {
        ...probedData,
        selectedLayerIds: ids,
      };
      data = payload;
    } else if (type === 'file') {
      // #296: the wizard already presigned + PUT the file when the
      // user picked it; we just have to require the upload finished
      // and stamp it onto the item's data here. No bytes flow through
      // the API; we only persist the metadata.
      if (!fileItemUpload) {
        setError('Choose a file to upload before creating the item.');
        return;
      }
      data = fileItemUpload;
    } else if (type === 'derived_layer') {
      // The wizard's DerivedLayerBuilder gathers the source layer +
      // pipeline up front (the recipe is structural, not optional).
      // Bail out with a friendly error if the user clicked Create
      // without picking a source / configuring a tool.
      if (!derivedLayerData) {
        setError('Pick a source data layer and configure at least one tool.');
        return;
      }
      const src = derivedLayerData.source;
      if (!src || !src.itemId) {
        setError('Pick a source data layer for this derived layer.');
        return;
      }
      if (
        !Array.isArray(derivedLayerData.pipeline) ||
        derivedLayerData.pipeline.length === 0
      ) {
        setError('Add at least one tool step to the pipeline.');
        return;
      }
      data = derivedLayerData;
    } else {
      data = {};
    }

    // #258: the picker still surfaces an "Editor" option that sets
    // type='editor' so the rest of the wizard's gating, validation,
    // and copy reads naturally. The persisted shape is web_app +
    // template='editor' though, so swap the type here at the
    // payload-build boundary. Keeps the user-facing word stable
    // while we collapse the storage model.
    // #158: postgis_connection never reaches this submit path
    // (the PostgisConnectionBuilder owns its own save flow), but
    // we still need to narrow it out of the union so TS is happy.
    if (type === 'postgis_connection') {
      throw new Error(
        'postgis_connection items save via PostgisConnectionBuilder, not the wizard submit path',
      );
    }
    const payloadType: ItemType =
      type === 'editor' ||
      type === 'viewer' ||
      type === 'custom'
        ? 'web_app'
        : type;

    const payload = {
      type: payloadType,
      title: title.trim(),
      description: description.trim(),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      access,
      thumbnailUrl,
      thumbnailDesign,
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

      // Save the credential against the freshly-created item so the
      // proxy works without manual setup (#74). Best-effort: a failure
      // here surfaces as an inline warning but the item still
      // exists, and the credentials card on the detail page can be
      // used to retry. We don't roll back the item on auth-save
      // failure -- that would lose the user's other typed metadata
      // and require restarting the wizard.
      if (pendingCredential) {
        // Snapshot what we're about to send and immediately clear
        // the in-component plaintext copies (#79). Once it's en
        // route to the API the wizard has no further use for it,
        // and not holding it in state means dev tools can't read
        // it off React internals after Create lands.
        const credToSend = pendingCredential;
        setPendingCredential(null);
        setCredentialToken('');
        setCredentialUsername('');
        setCredentialPassword('');
        try {
          const credRes = await fetch(
            `/api/portal/items/${saved.id}/credential`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(credToSend),
            },
          );
          if (!credRes.ok) {
            // Surface the actual server response so the user (and
            // logs) can see why the save bounced. Earlier we only
            // showed the status code which left bugs invisible
            // (e.g. server-side validation rejecting the payload
            // shape would just show "(400)" with no clue about
            // which field). #79
            const credText = await credRes.text().catch(() => '');
            let reason = '';
            try {
              const body = JSON.parse(credText) as {
                message?: string | string[];
              };
              const msg = body.message;
              if (Array.isArray(msg)) reason = msg.join('; ');
              else if (typeof msg === 'string') reason = msg;
            } catch {
              reason = credText;
            }
            console.error(
              `Saved item ${saved.id} but credential write failed: ${credRes.status} ${credText}`,
            );
            setError(
              `Item created, but the credential did not save (${credRes.status}${
                reason ? `: ${reason.slice(0, 200)}` : ''
              }). Open the item detail page to set it manually.`,
            );
            // Still navigate so the user lands on the new item and
            // can retry the credential save from its detail page.
          }
        } catch (credErr) {
          console.error('Credential save threw:', credErr);
          setError(
            `Item created, but the credential did not save (${
              credErr instanceof Error ? credErr.message : 'network error'
            }). Open the item detail page to set it manually.`,
          );
        }
      }
      // If the wizard was opened from inside a folder ("+ New
      // subfolder" on the folder detail page), append the freshly-
      // created item to that parent folder's childItemIds so the
      // subfolder actually appears under its parent. Without this
      // step the new folder is a sibling at top-level and the
      // parent's contents look unchanged. We do it client-side as a
      // follow-up PATCH rather than baking it into POST /items so
      // the API surface stays simple. Failure is surfaced inline
      // (the new item still exists; the user can manually drag it
      // into the parent later).
      const parentFolderId = searchParams?.get('parentFolderId') ?? null;
      if (parentFolderId) {
        try {
          const pr = await fetch(`/api/portal/items/${parentFolderId}`);
          if (pr.ok) {
            const parent = (await pr.json()) as {
              type: string;
              data: { childItemIds?: unknown } | null;
            };
            if (parent.type === 'folder') {
              const existing = Array.isArray(parent.data?.childItemIds)
                ? (parent.data!.childItemIds as unknown[]).filter(
                    (x): x is string => typeof x === 'string',
                  )
                : [];
              if (!existing.includes(saved.id)) {
                const next = {
                  version: 1,
                  childItemIds: [...existing, saved.id],
                };
                await fetch(`/api/portal/items/${parentFolderId}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ data: next }),
                });
              }
            }
          }
        } catch (parentErr) {
          console.error('Could not append to parent folder:', parentErr);
        }
        // Land the user back on the parent folder detail page so the
        // new subfolder is visible in its parent's contents.
        startTransition(() => router.push(`/items/${parentFolderId}`));
        return;
      }

      // data_layer with staged file uploads: fan out per-layer ingest
      // using ?stagingId=...&sourceLayer=... so the file uploaded
      // ONCE during the builder's Import flow gets reused for every
      // detected layer without re-uploading. We do this in series
      // (not parallel) so a 500 MB GDB doesn't trigger N concurrent
      // GDAL opens on the api process. mode=replace because the
      // freshly-created layer's table is empty -- there's nothing to
      // append to and the semantics match "load the file's data
      // into this layer". Failures here are NOT fatal: the item
      // exists, every layer's schema is right, and the user lands
      // on the detail page where they can retry per-layer Import
      // manually. We surface a banner-level error so they know.
      //
      // #115: enqueue async import jobs and navigate immediately.
      // Each per-layer import becomes a row in the import_job table;
      // the in-process worker drains the queue and updates progress
      // there. The detail page's import-progress banner reads the
      // same rows and renders live progress without us having to
      // hold the wizard open. End-user benefit: a 30-min county-
      // scale import no longer pins them to a modal.
      //
      // Failures here mean the JOB enqueue failed, not the import
      // itself. Surface those inline; the user can retry per-layer
      // from the detail page. Per-layer-import-while-running errors
      // surface in the detail-page banner from the import_job row.
      const ingestErrors: string[] = [];
      if (type === 'data_layer' && pendingFileImports.length > 0) {
        for (const entry of pendingFileImports) {
          for (const layer of entry.layers) {
            try {
              const enqueueUrl = `/api/portal/items/${saved.id}/layers/${layer.layerId}/import-jobs`;
              const enqueueRes = await fetch(enqueueUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  stagingId: entry.stagingId,
                  sourceLayerName: layer.sourceLayerName,
                  mode: 'replace',
                }),
              });
              if (!enqueueRes.ok) {
                const text = await enqueueRes.text().catch(() => '');
                ingestErrors.push(
                  `${layer.sourceLayerName}: ${enqueueRes.status} ${text.slice(0, 200)}`,
                );
              }
            } catch (err) {
              ingestErrors.push(
                `${layer.sourceLayerName}: ${
                  err instanceof Error ? err.message : 'network error'
                }`,
              );
            }
          }
        }
        setPendingFileImports([]);
      }
      // data_layer still wants the ingest panel front and centre.
      // arcgis_service no longer needs #configure-arcgis because we baked
      // the probed config into dataJson above.
      const anchor = type === 'data_layer' ? '#add-data' : '';
      const targetUrl = `/items/${saved.id}${anchor}`;

      if (ingestErrors.length > 0) {
        // Don't auto-navigate when any layer's enqueue failed. The
        // user just watched a row flip to red and needs the chance to
        // read what went wrong before being kicked to the detail page.
        // Stash the destination on the overlay state and let the user
        // dismiss with the Continue button (handler in the overlay
        // JSX) -- that's where the navigation actually fires now.
        setError(
          `Item created, but feature import failed for ${ingestErrors.length} layer(s). ` +
            `Use the per-layer Import button on the detail page to retry. Details: ` +
            ingestErrors.join('; ').slice(0, 500),
        );
        setIngestNavTarget(targetUrl);
      } else {
        startTransition(() => router.push(targetUrl));
      }
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
    // Drop any type the portal cannot actually service, and any group
    // left empty as a result, so a disabled feature leaves no heading
    // hanging over nothing.
    const visibleGroups = TYPE_GROUPS.map((g) => ({
      ...g,
      options: g.options.filter(
        (o) => o.value !== 'script' || scriptsEnabled,
      ),
    })).filter((g) => g.options.length > 0);
    return (
      <div className="space-y-8">
        {visibleGroups.map((group) => (
          <section key={group.label}>
            {/* Group header inherits the group color via a small
                bullet swatch + the icon-tile class for the chip
                background, so the eye associates each section's
                cards with their hue at a glance. */}
            <h2 className="mb-3 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <span
                aria-hidden="true"
                className={`inline-block h-2.5 w-2.5 rounded-full ${group.iconTileClass}`}
              />
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.options.map((opt) => {
                const { Icon } = opt;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => pickType(opt.value)}
                    className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-colors hover:border-accent/50 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  >
                    <span
                      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${group.iconTileClass}`}
                    >
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
          </section>
        ))}
      </div>
    );
  }

  // step === 'details'
  const typeOption = TYPE_OPTIONS.find((o) => o.value === type);
  const TypeIcon = typeOption?.Icon ?? Sparkles;
  // Look up which group this type belongs to so the selected-type
  // header inherits the same color the user clicked in the gallery.
  // Keeps the visual handoff coherent: "the blue thing I picked is
  // still blue on the next step."
  const typeGroup = type
    ? TYPE_GROUPS.find((g) => g.options.some((o) => o.value === type))
    : undefined;
  const typeIconTileClass =
    typeGroup?.iconTileClass ?? 'bg-accent/10 text-accent';

  return (
    <div className="space-y-8">
      {/* Selected-type header with back link. Keeps the user oriented
          without forcing a full page nav. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-md ${typeIconTileClass}`}
          >
            <TypeIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-2xs font-medium uppercase tracking-wide text-muted">
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

      {/* Custom Web App template gallery. Shown before the
          metadata fields when the user picked the Custom Web App
          type, so they're committing to a starting point before
          they title + describe the app. Templates are pre-
          configured CustomAppData instances (theme, containers,
          widgets already in place); the author lands in the
          designer with a working app to customize, not a blank
          canvas. The Blank template preserves the previous
          empty-page behavior for advanced users. */}
      {type === 'custom' ? (
        <section>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
            Start from a template
          </label>
          {appTemplates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface-1 p-4 text-sm text-muted">
              <p className="font-medium text-ink-1">
                No app templates available in your org.
              </p>
              <p className="mt-1 text-xs">
                Ask your admin to restore the starter templates via
                Admin &rarr; Housekeeping, or save an existing
                Custom Web App as a template to populate this list.
                You can still create a blank Custom Web App; it
                will land on the designer with no widgets.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {appTemplates.map((tpl) => {
                const active = customAppTemplateItemId === tpl.itemId;
                return (
                  <button
                    key={tpl.itemId}
                    type="button"
                    onClick={() =>
                      setCustomAppTemplateItemId(tpl.itemId)
                    }
                    aria-pressed={active}
                    className={`flex flex-col items-start gap-1.5 rounded-lg border bg-surface-1 p-3 text-left transition-colors ${
                      active
                        ? 'border-accent ring-2 ring-accent/30'
                        : 'border-border hover:border-ink-1 hover:bg-surface-2'
                    }`}
                  >
                    <span className="text-sm font-semibold text-ink-0">
                      {tpl.title}
                    </span>
                    {tpl.description ? (
                      <span className="text-xs text-muted">
                        {tpl.description}
                      </span>
                    ) : null}
                    {tpl.tags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {tpl.tags.map((tag) => (
                          <span
                            key={tag}
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-2xs ${
                              tag === 'built-in'
                                ? 'border-accent/30 bg-accent/10 text-accent'
                                : 'border-border bg-surface-2 text-muted'
                            }`}
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-2xs text-muted">
            Every template is a saved Custom Web App. After create,
            open the app and edit anything: widgets, layout, theme.
            You can also save your finished app as a template later
            for reuse.
          </p>
        </section>
      ) : null}

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
        <ThumbnailDesigner
          type={resolvedTypeForThumbnail}
          title={title}
          value={thumbnailDesign}
          onChange={setThumbnailDesign}
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
            setNeedsAuth(false);
            setPendingCredential(null);
          }}
          needsAuth={needsAuth}
          credentialKind={credentialKind}
          onCredentialKindChange={setCredentialKind}
          credentialToken={credentialToken}
          onCredentialTokenChange={setCredentialToken}
          credentialUsername={credentialUsername}
          onCredentialUsernameChange={setCredentialUsername}
          credentialPassword={credentialPassword}
          onCredentialPasswordChange={setCredentialPassword}
          onProbeWithCredential={runArcgisProbeWithCredential}
          credentialUsed={pendingCredential !== null}
        />
      ) : null}

      {type === 'data_layer' ? (
        <DataLayerBuilder
          value={featureServiceData}
          onChange={setDataLayerData}
          onPendingFileImport={(entry) =>
            setPendingFileImports((prev) => [...prev, entry])
          }
        />
      ) : null}

      {type === 'derived_layer' ? (
        <DerivedLayerBuilder
          value={derivedLayerData}
          onChange={setDerivedLayerData}
        />
      ) : null}

      {type === 'data_collection' ? (
        <DataCollectionBuilder
          value={dataCollectionMapId}
          onChange={setDataCollectionMapId}
        />
      ) : null}

      {type === 'postgis_connection' ? (
        <PostgisConnectionBuilder
          title={title}
          description={description}
          canSave={title.trim().length > 0}
        />
      ) : null}

      {type === 'file' ? (
        <FileItemUploader value={fileItemUpload} onChange={setFileItemUpload} />
      ) : null}

      {type === 'basemap' ? (
        <BasemapConfigSection value={basemapDraft} onChange={setBasemapDraft} />
      ) : null}

      {type === 'service' ? (
        <ServiceConfigSection
          urlDraft={serviceUrlDraft}
          onUrlChange={setServiceUrlDraft}
          probing={serviceProbing}
          probeError={serviceProbeError}
          probeResult={serviceProbeResult}
          selectedLayerNames={serviceSelectedLayerNames}
          onSelectedLayerNamesChange={setServiceSelectedLayerNames}
          onProbe={runServiceProbe}
          onDiscardProbe={() => {
            setServiceProbeResult(null);
            setServiceSelectedLayerNames(new Set());
            setServiceProbeError(null);
          }}
        />
      ) : null}

      {type === 'wms_service' || type === 'wfs_service' ? (
        <OgcConfigSection
          kind={type === 'wms_service' ? 'wms' : 'wfs'}
          urlDraft={ogcUrlDraft}
          onUrlChange={setOgcUrlDraft}
          probing={ogcProbing}
          probeError={ogcProbeError}
          probeResult={ogcProbeResult}
          selectedLayerNames={ogcSelectedLayerNames}
          onSelectedLayerNamesChange={setOgcSelectedLayerNames}
          onProbe={runOgcProbe}
          onDiscardProbe={() => {
            setOgcProbeResult(null);
            setOgcSelectedLayerNames(new Set());
            setOgcProbeError(null);
          }}
        />
      ) : null}

      {error ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          <p>{error}</p>
          {ingestNavTarget ? (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  const target = ingestNavTarget;
                  setIngestNavTarget(null);
                  startTransition(() => router.push(target));
                }}
                className="inline-flex h-7 items-center gap-1 rounded bg-danger px-2.5 text-xs font-medium text-white hover:opacity-90"
              >
                Continue to item
              </button>
            </div>
          ) : null}
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
        {/* #158: postgis_connection uses its own dedicated Save
            button inside PostgisConnectionBuilder because the
            backend path is a single-shot /postgis-live/create
            (which does test + create + credential + probe) rather
            than the generic items POST. Hide the wizard's
            generic Create button to avoid double-save UX. */}
        {type !== 'postgis_connection' ? (
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
        ) : null}
      </div>
    </div>
  );
}

/**
 * Wizard pane for type='file' (#296). Picks one file from the user's
 * disk, presigns + PUTs it to MinIO, and reports the resulting
 * FileData up to the wizard. Same direct-to-MinIO pattern the form
 * runtime + ImageUploader use, just with the bigger 100 MB cap and
 * the any-MIME relaxation the storage service grants the
 * 'item-file' kind.
 *
 * Once the upload completes the user sees the file metadata + a
 * "Replace" button to reupload. The wizard's submit() blocks until
 * an upload is registered.
 */
function FileItemUploader({
  value,
  onChange,
}: {
  value: FileData | null;
  onChange: (next: FileData | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'item-file',
          contentType: file.type || 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        setError(`Could not start upload: ${presignRes.status}`);
        return;
      }
      const { uploadUrl, publicUrl, key, maxBytes } =
        (await presignRes.json()) as {
          uploadUrl: string;
          publicUrl: string;
          key: string;
          maxBytes: number;
        };
      if (file.size > maxBytes) {
        const maxMb = Math.round(maxBytes / (1024 * 1024));
        setError(`File too large. Max is ${maxMb} MB.`);
        return;
      }

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putRes.ok) {
        setError(`Upload failed: ${putRes.status}`);
        return;
      }

      onChange({
        version: 1,
        storageKey: key,
        storageUrl: publicUrl,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString() as ISODateString,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">File</h2>
      <p className="mb-3 text-xs text-muted">
        Pick the file to upload. Max 100 MB. Stays on your portal&rsquo;s
        own storage; no third-party services.
      </p>
      {value ? (
        <div className="flex items-start gap-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-ink-0">
              {value.fileName}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {humanFileSize(value.sizeBytes)} &middot;{' '}
              <span className="font-mono">{value.mimeType}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              inputRef.current?.click();
            }}
            disabled={busy}
            className="h-8 shrink-0 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 text-sm text-ink-1 hover:bg-surface-1 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
          {busy ? 'Uploading...' : 'Choose a file'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Reset so re-picking the same file fires onChange again.
          e.target.value = '';
        }}
      />
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Wizard pane for type='service' (#304 slice 3).
 *
 * Single entry point that replaces the four protocol-specific
 * tiles (ArcGIS service, WMS service, WFS service, and the not-yet-
 * shipped WMTS). Auto-detect probe figures out the protocol from
 * the URL response so the user doesn't have to know upfront whether
 * they're pointing at a MapServer, a WMS, or a WMTS endpoint.
 *
 * Two-stage layout: paste URL, click Probe; on success the
 * detected protocol + service title surface in a summary line
 * and the layer picker shows up with all layers checked by
 * default. The user can uncheck individual layers to curate.
 */
function ServiceConfigSection({
  urlDraft,
  onUrlChange,
  probing,
  probeError,
  probeResult,
  selectedLayerNames,
  onSelectedLayerNamesChange,
  onProbe,
  onDiscardProbe,
}: {
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeError: string | null;
  probeResult: ServiceProbeResult | null;
  selectedLayerNames: Set<string>;
  onSelectedLayerNamesChange: (next: Set<string>) => void;
  onProbe: () => void;
  onDiscardProbe: () => void;
}) {
  const data = probeResult?.data;
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">
        Connected service
      </h2>
      <p className="mb-3 text-xs text-muted">
        Paste the service URL. We&rsquo;ll detect whether it&rsquo;s ArcGIS
        REST, WMS, WFS, or WMTS and load the layer list from the server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          inputMode="url"
          value={urlDraft}
          disabled={probing || !!probeResult}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://example.org/arcgis/rest/services/.../MapServer"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-sm font-mono"
        />
        {probeResult ? (
          <button
            type="button"
            onClick={onDiscardProbe}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Try a different URL
          </button>
        ) : (
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
            {probing ? 'Probing...' : 'Probe'}
          </button>
        )}
      </div>
      {probeError ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {probeError}
        </p>
      ) : null}
      {probeResult && data ? (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <div className="text-muted">
              <span className="mr-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-accent">
                {serviceProtocolLabel(data.protocol)}
              </span>
              {data.serviceTitle ? (
                <>
                  <span className="font-medium text-ink-0">{data.serviceTitle}</span>
                  {' Â· '}
                </>
              ) : null}
              {data.layers.length} layer{data.layers.length === 1 ? '' : 's'}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() =>
                  onSelectedLayerNamesChange(
                    new Set(data.layers.map((l) => l.name)),
                  )
                }
                className="h-6 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => onSelectedLayerNamesChange(new Set())}
                className="h-6 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
              >
                Clear
              </button>
            </div>
          </div>
          {data.layers.length === 0 ? (
            <p className="text-xs text-muted">
              The server didn&rsquo;t advertise any named layers.
              Double-check the URL points at the GetCapabilities
              endpoint (or the ArcGIS REST service root).
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto rounded border border-border bg-surface-1 text-xs">
              {data.layers.map((l) => {
                const checked = selectedLayerNames.has(l.name);
                return (
                  <li
                    key={l.name}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selectedLayerNames);
                        if (checked) next.delete(l.name);
                        else next.add(l.name);
                        onSelectedLayerNamesChange(next);
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink-0">{l.title}</span>
                      {l.title !== l.name ? (
                        <span className="ml-2 font-mono text-muted">{l.name}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Wizard pane for type='wms_service' / 'wfs_service' (#297).
 *
 * Mirrors the ArcGIS probe section but simpler: no auth flow yet
 * (most public WMS / WFS endpoints are anonymous), and the layer ids
 * are strings (Name / typeName), not the integer ids ArcGIS uses.
 *
 * Two-stage layout: paste a URL, click Probe; on success the layer
 * picker appears with all layers checked by default. The user can
 * uncheck individual layers to curate which appear in the item.
 */
function OgcConfigSection({
  kind,
  urlDraft,
  onUrlChange,
  probing,
  probeError,
  probeResult,
  selectedLayerNames,
  onSelectedLayerNamesChange,
  onProbe,
  onDiscardProbe,
}: {
  kind: 'wms' | 'wfs';
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeError: string | null;
  probeResult: OgcCapabilities | null;
  selectedLayerNames: Set<string>;
  onSelectedLayerNamesChange: (next: Set<string>) => void;
  onProbe: () => void;
  onDiscardProbe: () => void;
}) {
  const protocolLabel = kind === 'wms' ? 'WMS' : 'WFS';
  const layerWord = kind === 'wms' ? 'layer' : 'feature type';
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">
        {protocolLabel} service
      </h2>
      <p className="mb-3 text-xs text-muted">
        Paste the GetCapabilities base URL (no query string). Probe to
        load the {layerWord} list from the server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          inputMode="url"
          value={urlDraft}
          disabled={probing || !!probeResult}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={
            kind === 'wms'
              ? 'https://example.org/geoserver/wms'
              : 'https://example.org/geoserver/wfs'
          }
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-sm font-mono"
        />
        {probeResult ? (
          <button
            type="button"
            onClick={onDiscardProbe}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Try a different URL
          </button>
        ) : (
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
            {probing ? 'Probing...' : 'Probe'}
          </button>
        )}
      </div>
      {probeError ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {probeError}
        </p>
      ) : null}
      {probeResult ? (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <div className="text-muted">
              {probeResult.title ? (
                <>
                  <span className="font-medium text-ink-0">{probeResult.title}</span>
                  {' Â· '}
                </>
              ) : null}
              {protocolLabel} {probeResult.protocolVersion} Â· {probeResult.layers.length}{' '}
              {layerWord}
              {probeResult.layers.length === 1 ? '' : 's'}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() =>
                  onSelectedLayerNamesChange(
                    new Set(probeResult.layers.map((l) => l.name)),
                  )
                }
                className="h-6 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => onSelectedLayerNamesChange(new Set())}
                className="h-6 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
              >
                Clear
              </button>
            </div>
          </div>
          {probeResult.layers.length === 0 ? (
            <p className="text-xs text-muted">
              The server didn&rsquo;t advertise any named {layerWord}s. Double-check
              the URL points at the GetCapabilities endpoint.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto rounded border border-border bg-surface-1 text-xs">
              {probeResult.layers.map((l) => {
                const checked = selectedLayerNames.has(l.name);
                return (
                  <li
                    key={l.name}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selectedLayerNames);
                        if (checked) next.delete(l.name);
                        else next.add(l.name);
                        onSelectedLayerNamesChange(next);
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink-0">{l.title}</span>
                      {l.title !== l.name ? (
                        <span className="ml-2 text-muted">
                          <span className="font-mono">{l.name}</span>
                        </span>
                      ) : (
                        <span className="ml-2 font-mono text-muted">{l.name}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}


/** Human-friendly size string for the file metadata row. */
function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  /** True when the anonymous probe came back as auth-required and
   *  the user should fill in a credential to proceed. (#74) */
  needsAuth: boolean;
  credentialKind: 'arcgis_token' | 'bearer' | 'basic';
  onCredentialKindChange: (kind: 'arcgis_token' | 'bearer' | 'basic') => void;
  credentialToken: string;
  onCredentialTokenChange: (v: string) => void;
  credentialUsername: string;
  onCredentialUsernameChange: (v: string) => void;
  credentialPassword: string;
  onCredentialPasswordChange: (v: string) => void;
  /** Re-runs probe through the server-side endpoint with the
   *  credential injected. Same response shape as onProbe. (#74) */
  onProbeWithCredential: () => void | Promise<void>;
  /** True after a credentialed probe succeeded; the form shows a
   *  reassurance pill so the user knows the secret is staged for
   *  save-on-create. (#74) */
  credentialUsed: boolean;
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
  needsAuth,
  credentialKind,
  onCredentialKindChange,
  credentialToken,
  onCredentialTokenChange,
  credentialUsername,
  onCredentialUsernameChange,
  credentialPassword,
  onCredentialPasswordChange,
  onProbeWithCredential,
  credentialUsed,
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

      {/* Credential form (#74). Appears when the anonymous probe came
          back as auth-required, OR after a credentialed probe has
          succeeded (so the user can change their mind and re-enter).
          Plaintext lives in component state for the duration of the
          wizard; it gets POSTed to the new item's credential endpoint
          right after Create succeeds. */}
      {needsAuth || credentialUsed ? (
        <div className="rounded-md border border-warn/30 bg-warn/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-warn">
            <Lock className="h-3.5 w-3.5" />
            Authentication required
            {credentialUsed ? (
              <span className="ml-1 rounded-full border border-success/40 bg-success/10 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-success">
                staged
              </span>
            ) : null}
          </div>
          <p className="mb-2 text-2xs text-warn/90">
            The credential is stored encrypted on this item once it&apos;s
            created. Calls from the map go through a server-side proxy
            so the secret never reaches the browser.
          </p>

          <div className="mb-2 grid grid-cols-3 gap-1">
            {(
              ['basic', 'arcgis_token', 'bearer'] as const
            ).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onCredentialKindChange(k)}
                className={`rounded border px-2 py-1.5 text-left text-xs ${
                  credentialKind === k
                    ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
                }`}
              >
                <div className="font-medium capitalize">
                  {k === 'arcgis_token'
                    ? 'ArcGIS token'
                    : k === 'bearer'
                      ? 'Bearer'
                      : 'Basic'}
                </div>
                <div className="text-2xs text-muted">
                  {k === 'arcgis_token'
                    ? '?token=... query param'
                    : k === 'bearer'
                      ? 'Authorization: Bearer'
                      : 'Username + password'}
                </div>
              </button>
            ))}
          </div>

          {credentialKind === 'basic' ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              <input
                type="text"
                autoComplete="off"
                value={credentialUsername}
                onChange={(e) => onCredentialUsernameChange(e.target.value)}
                placeholder="Username"
                className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <input
                type="password"
                autoComplete="new-password"
                value={credentialPassword}
                onChange={(e) => onCredentialPasswordChange(e.target.value)}
                placeholder="Password"
                className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
          ) : (
            <input
              type="password"
              autoComplete="new-password"
              value={credentialToken}
              onChange={(e) => onCredentialTokenChange(e.target.value)}
              placeholder={
                credentialKind === 'arcgis_token'
                  ? 'Paste an ArcGIS token (e.g. from generateToken)'
                  : 'Paste a bearer token'
              }
              className="mb-2 h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          )}

          <button
            type="button"
            onClick={() => void onProbeWithCredential()}
            disabled={probing}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-warn/50 bg-warn/15 px-3 text-xs font-medium text-warn hover:bg-warn/25 disabled:opacity-50"
          >
            {probing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Probe with credential
          </button>
        </div>
      ) : null}

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
              <p className="mt-0.5 flex items-center gap-1 text-2xs text-muted">
                <span>{probeResult.serviceType}</span>
                <span aria-hidden="true">Â·</span>
                <span>
                  {probeResult.layers.length}{' '}
                  {probeResult.layers.length === 1 ? 'layer' : 'layers'}
                </span>
                <span aria-hidden="true">Â·</span>
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
              className="shrink-0 rounded border border-border bg-surface-1 px-2 py-1 text-2xs text-muted hover:bg-surface-2"
            >
              Clear
            </button>
          </div>

          {probeResult.layers.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted">
                  Layers to include
                  <span className="ml-1.5 text-muted normal-case tracking-normal">
                    ({selectedLayerIds.size} of{' '}
                    {probeResult.layers.length} selected)
                  </span>
                </p>
                <div className="flex items-center gap-1 text-2xs">
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
                      <span className="shrink-0 text-2xs uppercase tracking-wide text-muted">
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
                        className={`shrink-0 rounded px-1 text-2xs font-semibold ${
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
              <p className="mt-1 text-2xs text-muted">
                Unchecked layers stay in the upstream service but this
                item will not expose them. The default layer is loaded
                when a map picks this item without a specific layer
                choice.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-2xs text-muted">
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
