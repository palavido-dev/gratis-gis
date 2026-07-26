// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AGO migration importer (workstream 3, phase 4).
 *
 * Consumes a `DryRunReport` + AGO connection params and creates
 * the planned portal items. Per-item failures are isolated --
 * a broken Web Map doesn't take down the rest of the import.
 * The result is an `ImportReport` listing every item the worker
 * touched, what happened, and any per-item warnings.
 *
 * v1 scope (this commit):
 *
 *   - Services (Feature / Map / Image / Vector Tile) -> portal
 *     `service` item with the AGO URL + protocol; service layer
 *     probing deferred to a portal admin re-probe.
 *
 *   - Web Maps -> portal `map` item via the existing
 *     `WebMapJsonImportService` (which already converts the
 *     WebMap JSON envelope and links matching service items).
 *
 *   - Files (Image / PDF / CSV / Document Link / ...) ->
 *     portal `file` item carrying the AGO download URL. v1
 *     does NOT re-host file contents; the URL stays attached
 *     to AGO. Later phases can add re-hosting via MinIO.
 *
 * Out of v1 scope: Web Mapping Applications, Dashboards, Forms,
 * StoryMap, Experience Builder. These items have AGO-runtime-
 * specific configs that don't round-trip cleanly into the
 * portal's own runtimes; trying to recreate them lossily would
 * leave the user worse off than rebuilding from the imported
 * underlying maps + layers. They surface in the dry-run as
 * "skip with reason" so the operator knows what was left behind.
 *
 * The importer runs synchronously inside the HTTP request. For
 * a small AGO account (test orgs, hobby portals) the whole
 * import completes in seconds. The shape stays usable inside a
 * future ImportJob row for large orgs where async + restart-
 * safe is required.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EsriWebMap } from '@gratis-gis/engine';
import { DEFAULT_FILE, DEFAULT_FOLDER } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { safeFetch } from '../common/net-guards.js';
import { ItemsService } from '../items/items.service.js';
import { StorageService } from '../storage/storage.service.js';
import { WebMapJsonImportService } from '../items/web-map-json-import.service.js';

import { AgoApiError, AgoClient } from './ago-client.js';
import { agoAccessToPortal, type DryRunItem, type DryRunReport } from './dry-run.js';
import { AgoHostedFsImportService } from './hosted-fs.js';
import { sortByImportOrder } from './type-mapping.js';

/**
 * One row in the import report. ``status`` is always set;
 * ``portalItemId`` / ``portalItemType`` set when status is
 * 'created'; ``error`` set when status is 'failed'.
 */
export interface ImportResult {
  agoId: string;
  agoType: string;
  agoTitle: string;
  status: 'created' | 'failed' | 'skipped';
  portalItemId?: string;
  portalItemType?: string;
  /** Per-item warnings (sub-conversions that didn't translate
   *  cleanly, e.g. unknown layer in a Web Map, untranslated
   *  Dashboard widget). Always an array; empty when the import
   *  was clean. */
  warnings: string[];
  /** Set when status is 'failed'. */
  error?: string;
}

/**
 * Aggregate import report. Hands back to the dialog (or
 * eventually to an ImportJob row) so the operator can see what
 * happened end-to-end.
 */
export interface ImportReport {
  total: number;
  created: number;
  failed: number;
  skipped: number;
  results: ImportResult[];
  /** Folders the importer created to mirror the AGO folder layout.
   *  Empty when the source had no folders (everything at root) or
   *  when folder creation was skipped entirely (e.g. an empty
   *  willImport set). */
  folders: ImportedFolder[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** One folder the importer created. The dialog uses this to show
 *  "imported into 3 folders: Field Data, Maps, Public" after the
 *  job finishes. */
export interface ImportedFolder {
  agoFolderId: string;
  title: string;
  portalItemId: string;
  /** Number of items the importer placed in this folder. May be
   *  zero if every item in the AGO folder was skipped or failed. */
  childCount: number;
}

@Injectable()
export class AgoImportService {
  private readonly log = new Logger(AgoImportService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly webMapImport: WebMapJsonImportService,
    private readonly hostedFs: AgoHostedFsImportService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Execute the import described by ``args.report``. Walks the
   * report's items in dependency order (services before maps,
   * maps before apps) so later items can reference earlier ones
   * via stable portal item ids.
   */
  async run(args: {
    user: AuthUser;
    portalUrl: string;
    token: string;
    report: DryRunReport;
    /** Per-item callback so the dialog / async job runner can
     *  stream progress without buffering. May be async; the
     *  importer awaits it before moving to the next item. The
     *  async job runner uses this to write progress to the
     *  AgoImportJob row and check for caller-initiated cancellation
     *  (it throws a sentinel error to abort the run from inside
     *  the callback). */
    onProgress?: (state: {
      result: ImportResult;
      done: number;
      total: number;
      currentItem: string;
    }) => void | Promise<void>;
  }): Promise<ImportReport> {
    const startedAt = new Date();
    const client = new AgoClient({
      portalUrl: args.portalUrl,
      token: args.token,
    });

    // Phase 6: pre-create one portal folder per AGO folder that
    // actually contains at least one importable item. Skipping
    // empty folders keeps the portal-side folder list from filling
    // with placeholders that the operator has to clean up later.
    const folderIdsWithImports = new Set<string>();
    for (const it of args.report.items) {
      if (!it.willImport) continue;
      if (it.ownerFolder) folderIdsWithImports.add(it.ownerFolder);
    }
    const portalFolderByAgoId = new Map<string, string>();
    const folderChildIds = new Map<string, string[]>();
    const folderReport: ImportedFolder[] = [];
    for (const folder of args.report.folders) {
      if (!folderIdsWithImports.has(folder.id)) continue;
      try {
        const created = await this.items.create(args.user, {
          type: 'folder',
          title: folder.title,
          // FolderData has an optional smartQuery field that TS
          // doesn't see as Prisma.InputJsonValue-compatible
          // directly; an explicit cast keeps the type-check happy
          // without losing the shape contract (FolderData itself
          // is the validator).
          data: {
            ...DEFAULT_FOLDER,
            childItemIds: [],
          } as unknown as Prisma.InputJsonValue,
          access: 'private',
        });
        portalFolderByAgoId.set(folder.id, created.id);
        folderChildIds.set(folder.id, []);
        folderReport.push({
          agoFolderId: folder.id,
          title: folder.title,
          portalItemId: created.id,
          childCount: 0,
        });
      } catch (e) {
        // Folder-create failure is non-fatal: items just land at
        // the root instead of in the missing folder. Log + keep
        // going so a permission edge doesn't take down the whole
        // import.
        this.log.warn(
          'Failed to create AGO folder %s ("%s"): %s',
          folder.id,
          folder.title,
          errorMessage(e),
        );
      }
    }

    // Order: services first (so maps can reference them),
    // then maps, then files. Items the report marks as
    // not-importable stay out entirely.
    //
    // ``sortByImportOrder`` keys on a ``type`` field; DryRunItem
    // uses ``agoType``. Wrap so the sort stays type-driven and
    // the result preserves DryRunItem rows.
    const ordered = sortByImportOrder(
      args.report.items
        .filter((row) => row.willImport)
        .map((row) => ({ ...row, type: row.agoType })),
    ) as DryRunItem[];

    // Track AGO service URL -> portal data_layer info as the
    // import progresses. The WebMap importer reads this on the
    // map-import step so any operationalLayer that points at a
    // hosted FS we just imported gets rerouted to the portal
    // item directly -- no string-rewrite-then-re-resolve dance,
    // just a `{ kind: 'data-layer', itemId, layerKey }` source.
    // Without the agoLayerIdToSublayerKey on the value, the
    // converter would know which item we imported but not which
    // sublayer corresponds to AGO's `/<n>` suffix.
    const agoUrlToPortalDataLayer = new Map<
      string,
      {
        itemId: string;
        agoLayerIdToSublayerKey: Record<number, string>;
      }
    >();

    const results: ImportResult[] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const item = ordered[i]!;
      const result = await this.importOne(
        args.user,
        client,
        item,
        args.token,
        agoUrlToPortalDataLayer,
      ).catch(
        (e): ImportResult => ({
          agoId: item.agoId,
          agoType: item.agoType,
          agoTitle: item.title,
          status: 'failed',
          warnings: [],
          error: errorMessage(e),
        }),
      );
      // (Recording of hosted-FS -> data_layer URL mappings is
      // done inside importHostedFs itself so we always have the
      // per-sublayer-key detail handy.)
      results.push(result);
      // Track folder membership for the post-pass that writes
      // childItemIds back to each created folder.
      if (
        result.status === 'created' &&
        result.portalItemId &&
        item.ownerFolder &&
        folderChildIds.has(item.ownerFolder)
      ) {
        folderChildIds.get(item.ownerFolder)!.push(result.portalItemId);
      }
      // Progress hook fires AFTER folder bookkeeping so the runner
      // sees the final state for this item. The callback can also
      // throw to abort the loop (the async job runner uses this for
      // cancellation); we let the error propagate to the run()
      // caller without wrapping it as a per-item failure.
      const nextItem = ordered[i + 1];
      await args.onProgress?.({
        result,
        done: i + 1,
        total: ordered.length,
        currentItem: nextItem
          ? `${nextItem.title} (${nextItem.agoType})`
          : '',
      });
    }

    // Skipped items from the report (willImport=false) are
    // recorded in the result so the dialog can render a single
    // unified table without re-merging with the dry-run.
    for (const item of args.report.items) {
      if (item.willImport) continue;
      results.push({
        agoId: item.agoId,
        agoType: item.agoType,
        agoTitle: item.title,
        status: 'skipped',
        warnings: item.reason ? [item.reason] : [],
      });
    }

    // Post-pass: populate each portal folder's childItemIds with
    // the list of items the importer placed in it. Done in one
    // update per folder rather than incrementally so a folder
    // never sits in a half-populated state.
    for (const [agoFolderId, portalFolderId] of portalFolderByAgoId) {
      const childIds = folderChildIds.get(agoFolderId) ?? [];
      try {
        await this.items.update(args.user, portalFolderId, {
          data: {
            ...DEFAULT_FOLDER,
            childItemIds: childIds,
          } as unknown as Prisma.InputJsonValue,
        });
      } catch (e) {
        this.log.warn(
          'Failed to populate childItemIds on portal folder %s: %s',
          portalFolderId,
          errorMessage(e),
        );
      }
      // Mirror the count into the report.
      const reportRow = folderReport.find(
        (r) => r.agoFolderId === agoFolderId,
      );
      if (reportRow) reportRow.childCount = childIds.length;
    }

    const completedAt = new Date();
    return {
      total: args.report.items.length,
      created: results.filter((r) => r.status === 'created').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
      folders: folderReport,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  /**
   * Dispatch one dry-run row to the per-type importer. The
   * dispatch is data-driven (looks at ``targetType``) so adding
   * a new type means: add a row in `type-mapping.ts`, add a
   * branch here, write a converter.
   */
  private async importOne(
    user: AuthUser,
    client: AgoClient,
    row: DryRunItem,
    token: string,
    agoUrlToPortalDataLayer: Map<
      string,
      { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
    >,
  ): Promise<ImportResult> {
    switch (row.targetType) {
      case 'service':
        return this.importService(user, row, token);
      case 'data_layer':
        // Hosted feature services route through the dedicated
        // hosted-FS importer that walks the AGO REST surface,
        // copies the schema, and streams every feature into
        // PostGIS. End-to-end migration: the new data_layer is
        // portal-owned and no longer depends on AGO. The
        // importer populates agoUrlToPortalDataLayer directly so
        // a Web Map imported later in the same run can remap its
        // operationalLayer URLs to the just-imported portal
        // data_layer + sublayer (the right sublayer, not just
        // "some sublayer in the matching item").
        return this.importHostedFs(
          user,
          row,
          token,
          agoUrlToPortalDataLayer,
        );
      case 'map':
        return this.importMap(user, client, row, agoUrlToPortalDataLayer);
      case 'file':
        return this.importFile(user, row, token);
      default:
        // The dry-run + type-mapping should have caught
        // unsupported types and marked them willImport=false
        // before we got here. Anything that lands here is a
        // mapping-table drift we should fail loudly on so
        // it's caught in dev rather than silently dropped.
        return {
          agoId: row.agoId,
          agoType: row.agoType,
          agoTitle: row.title,
          status: 'failed',
          warnings: [],
          error: `Importer does not handle target type "${row.targetType}".`,
        };
    }
  }

  /**
   * Hosted Feature Service -> portal data_layer. Delegates to the
   * AgoHostedFsImportService that owns the schema + feature copy
   * pipeline.
   */
  private async importHostedFs(
    user: AuthUser,
    row: DryRunItem,
    token: string,
    agoUrlToPortalDataLayer: Map<
      string,
      { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
    >,
  ): Promise<ImportResult> {
    const url = row.serviceUrl ?? '';
    if (!url) {
      return failed(row, 'AGO hosted Feature Service item carried no URL.');
    }
    const result = await this.hostedFs.run({
      user,
      serviceUrl: url,
      agoItemId: row.agoId,
      title: row.title,
      access: agoAccessToPortal(row.access),
      token,
      // v1: attempt attachments. Per-attachment failures land in
      // warnings; success path is silent.
      copyAttachments: true,
    });
    // Side-effect: record the AGO service URL -> portal data_layer
    // mapping so the Web Map importer can reroute operationalLayer
    // URLs that referenced this hosted FS. The lookup carries the
    // per-AGO-layer-id -> portal-sublayer-key map so we route the
    // correct sublayer (a multi-layer FS would otherwise lose its
    // sublayer identity).
    agoUrlToPortalDataLayer.set(normalizeAgoServiceUrl(url), {
      itemId: result.portalItemId,
      agoLayerIdToSublayerKey: result.agoLayerIdToSublayerKey,
    });
    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: result.portalItemId,
      portalItemType: 'data_layer',
      warnings: [
        `Copied ${result.featuresInserted.toLocaleString()} feature(s) across ${result.layerCount} layer(s)` +
          (result.attachmentsCopied > 0
            ? `, plus ${result.attachmentsCopied} attachment(s)`
            : '') +
          '.',
        ...result.warnings,
      ],
    };
  }

  // -----------------------------------------------------------
  // Per-type importers
  // -----------------------------------------------------------

  /**
   * AGO service items map onto portal ``service`` items. We
   * already know the AGO type so the protocol is derived from
   * the dry-run classification (the dry-run row's
   * ``serviceUrl`` carries the upstream URL).
   *
   * Auto-probe (#54): after creating the item we immediately
   * hit the service root with ``?f=json`` to enumerate layers
   * and tables, then write them onto the item via
   * ``items.update``. This means a freshly imported connected
   * service is immediately usable on the map; without it the
   * operator had to re-probe each service by hand. Probe
   * failures (auth required, 404, network) surface in warnings
   * but don't fail the import -- the item is still valid and a
   * manual re-probe will recover the layer list once the
   * operator supplies the missing credential.
   */
  private async importService(
    user: AuthUser,
    row: DryRunItem,
    token: string,
  ): Promise<ImportResult> {
    const url = row.serviceUrl ?? '';
    if (!url) {
      return failed(row, 'AGO service item carried no URL.');
    }
    const protocol = inferServiceProtocol(row.agoType);
    const data: Record<string, unknown> = {
      url,
      layers: [] as Array<{ name: string; title: string }>,
      version: 1,
      protocol,
      serviceTitle: row.title,
      selectedLayerIds: [] as number[],
      importSource: 'ago',
      agoItemId: row.agoId,
    };
    const created = await this.items.create(user, {
      type: 'service',
      title: row.title,
      data: data as unknown as Prisma.InputJsonValue,
      access: agoAccessToPortal(row.access),
    });

    // Auto-probe step. Best-effort: any failure here just leaves
    // the item with an empty layer list (the warning steers the
    // operator to the re-probe path).
    const probeWarnings: string[] = [];
    const probe = await probeAgoService(url, token);
    if (probe.ok) {
      const layers = probe.layers;
      const updateData: Record<string, unknown> = {
        ...data,
        layers,
        // Default-select every probed layer so the map / app
        // immediately shows the whole service rather than a blank
        // until the user opens the picker.
        selectedLayerIds: layers.map((_, i) => i),
        probedAt: new Date().toISOString(),
      };
      try {
        await this.items.update(user, created.id, {
          data: updateData as unknown as Prisma.InputJsonValue,
        });
      } catch (e) {
        probeWarnings.push(
          `Auto-probe enumerated ${layers.length} layer(s) but the item update failed: ${errorMessage(e)}. ` +
            'Re-probe the service from the portal admin UI to recover.',
        );
      }
    } else {
      probeWarnings.push(
        `Auto-probe could not enumerate layers (${probe.reason}). ` +
          'Re-probe the service from the portal admin UI once it is reachable; the item is otherwise valid.',
      );
    }

    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: created.id,
      portalItemType: 'service',
      warnings: probeWarnings,
    };
  }

  /**
   * Web Maps run through the existing
   * ``WebMapJsonImportService``. We fetch the /data envelope
   * here (the dry-run intentionally doesn't, so it stays cheap
   * for large walks).
   *
   * Hosted-FS remap: the importer threads
   * ``agoUrlToPortalDataLayer`` down to the WebMap converter so
   * any operational-layer URL that points at an AGO Feature
   * Service we just imported as a portal data_layer resolves
   * directly to a `{ kind: 'data-layer', itemId, layerKey }`
   * source instead of staying tethered to AGO. The previous
   * implementation pre-rewrote the URLs in the WebMap JSON, but
   * the downstream `mapSourceFromUrl` resolver only understands
   * FeatureServer/MapServer/GeoJSON shapes, so the rewritten
   * `/api/items/<id>/<n>` URLs fell through to "unrecognised"
   * and the map lost the layer entirely.
   */
  private async importMap(
    user: AuthUser,
    client: AgoClient,
    row: DryRunItem,
    agoUrlToPortalDataLayer: Map<
      string,
      { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
    >,
  ): Promise<ImportResult> {
    let webMap: EsriWebMap;
    try {
      webMap = await client.getItemData<EsriWebMap>(row.agoId);
    } catch (e) {
      return failed(row, `Fetching WebMap JSON failed: ${errorMessage(e)}`);
    }
    const result = await this.webMapImport.import({
      user,
      webMap,
      title: row.title,
      access: agoAccessToPortal(row.access),
      agoDataLayerLookup: agoUrlToPortalDataLayer,
    });
    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: result.itemId,
      portalItemType: 'map',
      warnings: [
        ...(result.remappedToDataLayerCount > 0
          ? [
              `Remapped ${result.remappedToDataLayerCount} layer reference(s) from AGO services to imported portal data_layers.`,
            ]
          : []),
        ...result.warnings,
      ],
    };
  }

  /**
   * File-typed AGO items become portal ``file`` items with the
   * bytes streamed into MinIO. This is the load-bearing step for
   * "actually migrating off AGO" -- before this, file items were
   * still tethered to AGO's storage.
   *
   * Mechanism:
   *   1. Fetch /sharing/rest/content/items/<id>/data with the
   *      bearer token. AGO returns the file binary for
   *      Image / PDF / CSV / Word / Excel / Shapefile items.
   *   2. Stream to a tmp local file, then push to MinIO via
   *      storage.uploadLocalFile which uses the standard
   *      `item-file/` prefix.
   *   3. Create a `file` portal item with the canonical FileData
   *      shape (storageKey + storageUrl + fileName + mimeType).
   *
   * Document Link items don't have bytes -- the AGO item just
   * stores a URL. v1 skips them with a clear warning rather than
   * creating a malformed file item.
   */
  private async importFile(
    user: AuthUser,
    row: DryRunItem,
    token: string,
  ): Promise<ImportResult> {
    if (row.agoType === 'Document Link') {
      // No bytes to re-host. Surface in results so the operator
      // can recreate it as a portal link elsewhere if needed.
      return {
        agoId: row.agoId,
        agoType: row.agoType,
        agoTitle: row.title,
        status: 'skipped',
        warnings: [
          `Document Link items point at an external URL with no bytes to re-host (${row.serviceUrl ?? 'unknown URL'}). ` +
            'Recreate as a portal hyperlink manually if needed.',
        ],
      };
    }
    try {
      const upload = await this.fetchAndUploadAgoFile(row, token);
      const data = {
        ...DEFAULT_FILE,
        storageKey: upload.storageKey,
        storageUrl: upload.storageUrl,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        uploadedAt: new Date().toISOString(),
      };
      const created = await this.items.create(user, {
        type: 'file',
        title: row.title,
        data: data as unknown as Prisma.InputJsonValue,
        access: agoAccessToPortal(row.access),
      });
      return {
        agoId: row.agoId,
        agoType: row.agoType,
        agoTitle: row.title,
        status: 'created',
        portalItemId: created.id,
        portalItemType: 'file',
        warnings: [
          `Re-hosted ${upload.fileName} (${formatBytes(upload.sizeBytes)}) into portal storage; no longer depends on AGO.`,
        ],
      };
    } catch (e) {
      return failed(
        row,
        `Could not re-host file from AGO: ${errorMessage(e)}`,
      );
    }
  }

  /**
   * Fetch one AGO file item's binary payload, stream it to a
   * local tmp file, and push it into MinIO. Returns the new
   * storage key + URL so the caller can wire them into a portal
   * file item's FileData blob.
   *
   * The MIME guess + filename fall back to AGO's own metadata
   * when present; the per-item HEAD-style probe on the /data URL
   * tries Content-Disposition + Content-Type headers AGO sets on
   * the streamed response so we don't have to second-guess the
   * source filename.
   */
  private async fetchAndUploadAgoFile(
    row: DryRunItem,
    token: string,
  ): Promise<{
    storageKey: string;
    storageUrl: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    // Resolve the AGO portal base from the row's metadata. v1 of
    // the importer doesn't carry a portalUrl per row, so we
    // reconstruct it from the serviceUrl (if any) or default to
    // AGO public cloud's /sharing/rest path. The /content/items/
    // <id>/data endpoint is the canonical download URL on every
    // ArcGIS portal.
    const portalBase = inferPortalBaseFromRow(row);
    const downloadUrl = `${portalBase}/content/items/${row.agoId}/data?token=${encodeURIComponent(token)}`;
    // safeFetch, not fetch: the base comes off the user-supplied
    // dry-run report, so this download must pass the same SSRF
    // guard the AgoClient routes all its traffic through.
    const res = await safeFetch(downloadUrl);
    if (!res.ok) {
      throw new Error(
        `AGO returned HTTP ${res.status} on /items/${row.agoId}/data`,
      );
    }
    // Stream to a tmp file so we don't blow up the api heap on
    // multi-hundred-MB CSVs or shapefile bundles.
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length === 0) {
      throw new Error('AGO returned an empty body; no bytes to re-host.');
    }
    const fileName =
      filenameFromContentDisposition(res.headers.get('content-disposition')) ??
      `${sanitizeForFilename(row.title)}${defaultExtensionFor(row.agoType)}`;
    const mimeType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    // Use os.tmpdir() rather than a hardcoded "/tmp/" so the path
    // resolves on every platform the api runs on (Linux prod,
    // Windows dev, macOS).
    const tmp = join(
      tmpdir(),
      `ago-file-${Date.now()}-${sanitizeForFilename(row.agoId)}`,
    );
    await writeFile(tmp, buf);
    try {
      const upload = await this.storage.uploadLocalFile(
        'item-file',
        tmp,
        mimeType,
      );
      return {
        storageKey: upload.key,
        storageUrl: upload.publicUrl,
        fileName,
        mimeType,
        sizeBytes: buf.length,
      };
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function inferServiceProtocol(
  agoType: string,
):
  | 'arcgis_map'
  | 'arcgis_features'
  | 'arcgis_vector_tiles'
  | 'arcgis_image' {
  switch (agoType) {
    case 'Feature Service':
      return 'arcgis_features';
    case 'Map Service':
      return 'arcgis_map';
    case 'Image Service':
      return 'arcgis_image';
    case 'Vector Tile Service':
      return 'arcgis_vector_tiles';
    default:
      // Should not happen given the dry-run pre-classified; if
      // a new service type slips through, falling back to
      // ``arcgis_map`` keeps the import unblocked and the
      // operator can fix it in portal admin.
      return 'arcgis_map';
  }
}

function failed(row: DryRunItem, error: string): ImportResult {
  return {
    agoId: row.agoId,
    agoType: row.agoType,
    agoTitle: row.title,
    status: 'failed',
    warnings: [],
    error,
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof AgoApiError) {
    return `AGO ${e.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Canonicalize an AGO service URL so the same upstream service
 * reaches the same map entry whether the dry-run captured it as
 * `.../FeatureServer`, `.../FeatureServer/`, or
 * `.../FeatureServer/0`. The hosted-FS importer stores at the
 * service root; the WebMap remapper resolves layer URLs that may
 * carry a sublayer suffix.
 *
 * Exposed so tests can pin the normalization behaviour.
 */
export function normalizeAgoServiceUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // Strip token + query string -- different tokens shouldn't
  // produce different map keys for the same service.
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  // Strip a trailing sublayer-id segment (.../FeatureServer/0).
  s = s.replace(/\/(\d+)\/*$/, '');
  // Strip trailing slashes.
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

/**
 * Best-effort: pull the /sharing/rest base out of a service URL
 * the row already carries. Falls back to AGO public-cloud's
 * canonical /sharing/rest for non-service file items (the
 * /content/items/<id>/data endpoint exists on every ArcGIS
 * portal; the URL just needs to point at the right one). The
 * importer's run() already validated the portalUrl up front, so
 * a fallback that mismatches the actual portal would fail at
 * fetch time with a clear AGO error.
 */
function inferPortalBaseFromRow(row: DryRunItem): string {
  if (row.serviceUrl) {
    // serviceUrl looks like https://palavido.maps.arcgis.com/arcgis/rest/services/X/FeatureServer
    // The sharing-rest base is on the same host, under /sharing/rest.
    try {
      const u = new URL(row.serviceUrl);
      return `${u.origin}/sharing/rest`;
    } catch {
      /* fall through */
    }
  }
  return 'https://www.arcgis.com/sharing/rest';
}

/**
 * Parse the filename out of a Content-Disposition response header.
 * AGO sets `attachment; filename="parcels.csv"` on /data downloads
 * for CSV / shapefile / etc. so we can preserve the original name
 * rather than synthesising one. Returns null if the header is
 * missing or doesn't carry a filename param.
 */
function filenameFromContentDisposition(
  header: string | null,
): string | null {
  if (!header) return null;
  // RFC 5987 filename* is also valid; AGO uses the plain filename
  // form in practice. Accept either with the same regex.
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m && m[1] ? decodeURIComponent(m[1].trim()) : null;
}

/**
 * Strip everything from a string that wouldn't be safe in a
 * filename. Falls back to "file" when the input collapses to
 * empty. Mirrors the safeFilename helper in the ingest service
 * but is local here so the import-ago module doesn't reach into
 * the ingest module's internals.
 */
function sanitizeForFilename(raw: string): string {
  let s = raw.replace(/[^\w.-]+/g, '_');
  s = s.replace(/^\.+/, '_').replace(/\.+$/, '_');
  return s.length > 0 && s !== '_' ? s.slice(0, 80) : 'file';
}

/**
 * Default file extension to suffix on a synthesised filename when
 * AGO doesn't surface a Content-Disposition. Maps AGO item types
 * onto the extension users expect on download.
 */
function defaultExtensionFor(agoType: string): string {
  switch (agoType) {
    case 'PDF':
      return '.pdf';
    case 'CSV':
      return '.csv';
    case 'Microsoft Word':
      return '.docx';
    case 'Microsoft Excel':
      return '.xlsx';
    case 'Shapefile':
      return '.zip';
    case 'Image':
      return '';
    default:
      return '';
  }
}

/**
 * Auto-probe (#54) for connected service items. After we create
 * a portal `service` item we immediately fetch the ArcGIS service
 * root with `?f=json` to enumerate layers + tables so the new
 * item is usable without a manual re-probe step.
 *
 * Returns either { ok: true, layers } or { ok: false, reason }.
 * Reasons are short human strings suitable for inclusion in the
 * per-item warning the import report surfaces.
 *
 * Probe failures are NOT treated as import failures: the AGO item
 * may require credentials the OAuth bearer doesn't satisfy
 * (different identity store, unauthed endpoint behind a private
 * portal) and the operator can recover with the existing in-app
 * probe flow once the item exists.
 */
async function probeAgoService(
  serviceUrl: string,
  token: string,
): Promise<
  | { ok: true; layers: Array<{ name: string; title: string; geometryType?: string }> }
  | { ok: false; reason: string }
> {
  // Strip any trailing sublayer id / query so we hit the service
  // root rather than a per-layer endpoint. The normalize helper
  // already exists for the WebMap remap path; reusing it keeps
  // the URL shape consistent.
  const root = normalizeAgoServiceUrl(serviceUrl);
  if (!root) return { ok: false, reason: 'service URL was empty' };
  const u = new URL(root);
  u.searchParams.set('f', 'json');
  if (token) u.searchParams.set('token', token);
  let res: Response;
  try {
    // safeFetch, not fetch: the service URL comes off the user-
    // supplied dry-run report. A blocked URL surfaces as the same
    // per-item warning a network error does.
    res = await safeFetch(u.toString());
  } catch (e) {
    return { ok: false, reason: `network error: ${errorMessage(e)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'service root did not return JSON' };
  }
  // AGO returns 200 with an error envelope on auth failure.
  if (
    body &&
    typeof body === 'object' &&
    'error' in (body as Record<string, unknown>)
  ) {
    const err = (body as { error?: { code?: number; message?: string } }).error;
    return {
      ok: false,
      reason: `AGO error ${err?.code ?? '?'}: ${err?.message ?? 'unknown'}`,
    };
  }
  const desc = body as {
    layers?: Array<{ id?: number; name?: string; geometryType?: string }>;
    tables?: Array<{ id?: number; name?: string }>;
  };
  const layers: Array<{
    name: string;
    title: string;
    geometryType?: string;
  }> = [];
  for (const l of desc.layers ?? []) {
    if (typeof l?.id !== 'number') continue;
    layers.push({
      name: String(l.id),
      title: l.name ?? `Layer ${l.id}`,
      ...(l.geometryType
        ? { geometryType: agoGeometryTypeToPortal(l.geometryType) }
        : {}),
    });
  }
  for (const t of desc.tables ?? []) {
    if (typeof t?.id !== 'number') continue;
    layers.push({
      name: String(t.id),
      title: t.name ?? `Table ${t.id}`,
    });
  }
  return { ok: true, layers };
}

/**
 * Map an Esri geometryType string onto the portal short form used
 * in ServiceLayerSnapshot.geometryType. Matches the same convention
 * the hosted-FS importer uses.
 */
function agoGeometryTypeToPortal(g: string): string {
  switch (g) {
    case 'esriGeometryPoint':
      return 'point';
    case 'esriGeometryMultipoint':
      return 'point';
    case 'esriGeometryPolyline':
      return 'line';
    case 'esriGeometryPolygon':
      return 'polygon';
    default:
      return g;
  }
}

/** Format a byte count for the post-import warning. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// remapWebMapLayers (the URL-rewrite Phase 6 approach) was
// removed when the AGO data_layer lookup was threaded into
// WebMapJsonImportService directly. The previous version
// rewrote operational-layer URLs to `/api/items/<id>/<n>`,
// but the downstream `mapSourceFromUrl` resolver only matched
// FeatureServer / MapServer / GeoJSON URL shapes -- so the
// rewritten URLs fell through to "unrecognised" and the
// layers ended up dropped. The lookup-based approach (see
// `matchAgoDataLayerSource` in web-map-json-import.service.ts)
// builds the right portal MapLayerSource directly.
