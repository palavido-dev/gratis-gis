// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Report generation: a report template filled once per feature and
 * printed to PDF.
 *
 * Values come from the expression engine under the requester's own
 * access (share limits included), so a report shows exactly what that
 * person could see in the layer. Photos need download permission on
 * the layer, the same as downloading an attachment. The HTML is built
 * with every value escaped, and Chromium prints it with scripts off
 * and no network: photos are inlined as data: URIs.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import {
  MAX_REPORT_BODY,
  MAX_REPORT_FEATURES,
  parseReportBody,
  renderReportHtml,
  REPORT_CSS,
  REPORT_PAGE_SIZES,
  reportText,
  type DataLayerDataV3,
  type FeatureField,
  type ParsedReportBody,
  type ReportPageSize,
  type ReportTemplateData,
  type ReportValue,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { assertAttachmentAccess } from '../data-layer/attachments-access.js';
import { DataLayerAttachmentsService } from '../data-layer/attachments.service.js';
import type { ItemWithShares } from '../expressions/expression-data.js';
import {
  ExpressionsService,
  MAX_EVALUATE_EXPRESSIONS,
  MAX_EVALUATE_ROWS,
} from '../expressions/expressions.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';

/** Photos per feature in a report. */
const MAX_PHOTOS_PER_FEATURE = 12;
/** Longest side of a photo in the report, in pixels. */
const PHOTO_MAX_PX = 1200;
/** Largest stored photo read for a report. */
const PHOTO_MAX_BYTES = 30 * 1024 * 1024;
/** Chromium sessions one API process holds for reports at once. */
const MAX_CONCURRENT_RENDERS = 2;

const PUPPETEER_FORMAT: Record<ReportPageSize, 'letter' | 'legal' | 'a4' | 'a3' | 'tabloid'> = {
  letter: 'letter',
  legal: 'legal',
  a4: 'a4',
  a3: 'a3',
  tabloid: 'tabloid',
};

export interface ReportSource {
  itemId: string;
  layerKey: string;
}

export interface FilledReport {
  /** One entry per feature, in the requested order. */
  features: Array<{ id: string; html: string }>;
  /** Problems with the template, once each. */
  issues: string[];
}

/** Read a report template's data defensively. */
export function readReportTemplate(data: unknown): ReportTemplateData {
  const d = (data ?? {}) as Partial<ReportTemplateData>;
  const src = Array.isArray(d.sources) ? d.sources[0] : undefined;
  if (!src || typeof src.itemId !== 'string' || typeof src.layerKey !== 'string') {
    throw new BadRequestException('This report template has no layer to report on yet.');
  }
  const size = REPORT_PAGE_SIZES.includes(d.page?.size as ReportPageSize)
    ? (d.page!.size as ReportPageSize)
    : 'letter';
  return {
    version: 1,
    sources: [{ itemId: src.itemId, layerKey: src.layerKey }],
    body: typeof d.body === 'string' ? d.body : '',
    page: { size, orientation: d.page?.orientation === 'landscape' ? 'landscape' : 'portrait' },
    ...(typeof d.fileName === 'string' ? { fileName: d.fileName } : {}),
  };
}

@Injectable()
export class ReportsService {
  private readonly log = new Logger(ReportsService.name);
  private activeRenders = 0;

  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly expressions: ExpressionsService,
    private readonly attachments: DataLayerAttachmentsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Fill a body for features of a layer. With no feature ids, the
   * first `limit` features are used (the editor's preview).
   */
  async fill(
    user: AuthUser,
    source: ReportSource,
    body: string,
    opts: { featureIds?: string[]; limit?: number; photos?: 'inline' | 'none' },
  ): Promise<FilledReport> {
    if (body.length > MAX_REPORT_BODY) {
      throw new BadRequestException(`A report template is at most ${MAX_REPORT_BODY} characters.`);
    }
    const item = (await this.items.get(user, source.itemId)) as unknown as ItemWithShares;
    if (item.type !== 'data_layer')
      throw new BadRequestException('Reports are made from a data layer.');
    // Checks the layer exists and is one expressions can read.
    this.expressions.layerOf(item, source.layerKey);
    const fields =
      (item.data as unknown as DataLayerDataV3 | null)?.layers?.find(
        (l) => l.id === source.layerKey,
      )?.fields ?? [];
    const parsed = parseReportBody(body);
    const issues: string[] = [];

    const ids = opts.featureIds?.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids && ids.length > MAX_REPORT_FEATURES) {
      throw new BadRequestException(
        `A report covers at most ${MAX_REPORT_FEATURES} features at a time.`,
      );
    }
    const values = await this.computeValues(
      user,
      item,
      source.layerKey,
      fields,
      parsed,
      ids,
      opts.limit ?? 1,
      issues,
    );
    const order = ids ?? [...values.keys()];
    const photos =
      opts.photos !== 'none' && parsed.placeholders.some((p) => p.kind === 'photos')
        ? await this.photosFor(user, source, order, issues)
        : new Map<string, ReportValue>();

    const features = order
      .filter((id) => values.has(id))
      .map((id) => {
        const row = values.get(id)!;
        const vals = parsed.placeholders.map((p, k) =>
          p.kind === 'photos' ? (photos.get(id) ?? { images: [] }) : (row[k] ?? null),
        );
        return { id, html: renderReportHtml(parsed, vals) };
      });
    if (ids && features.length < ids.length) {
      issues.push(
        `${ids.length - features.length} of the selected features could not be read and were left out.`,
      );
    }
    return { features, issues };
  }

  /** Values for every field and expression placeholder, by feature id. */
  private async computeValues(
    user: AuthUser,
    item: ItemWithShares,
    layerKey: string,
    fields: FeatureField[],
    parsed: ParsedReportBody,
    ids: string[] | undefined,
    limit: number,
    issues: string[],
  ): Promise<Map<string, Array<ReportValue | null>>> {
    const out = new Map<string, Array<ReportValue | null>>();
    const exprs: Array<{ index: number; source: string; field?: FeatureField }> = [];
    parsed.placeholders.forEach((p, index) => {
      if (p.kind === 'field') {
        const field =
          fields.find((f) => f.name === p.name) ??
          fields.find((f) => f.name.toLowerCase() === p.name.toLowerCase());
        if (!field) {
          issues.push(`{{${p.name}}} is not a field on this layer.`);
          return;
        }
        exprs.push({ index, source: `{{${field.name}}}`, field });
      } else if (p.kind === 'expression') {
        exprs.push({ index, source: p.source });
      }
    });
    const labels = await this.domainLabels(
      user,
      exprs.map((e) => e.field).filter((f): f is FeatureField => !!f),
    );

    // With no expressions at all, still list the features.
    const batches: Array<typeof exprs> = [];
    for (let i = 0; i < exprs.length; i += MAX_EVALUATE_EXPRESSIONS)
      batches.push(exprs.slice(i, i + MAX_EVALUATE_EXPRESSIONS));
    if (batches.length === 0) batches.push([{ index: -1, source: 'null' }]);
    const idChunks: Array<string[] | undefined> = [];
    if (ids)
      for (let i = 0; i < ids.length; i += MAX_EVALUATE_ROWS)
        idChunks.push(ids.slice(i, i + MAX_EVALUATE_ROWS));
    else idChunks.push(undefined);

    const reported = new Set<string>();
    for (const chunk of idChunks) {
      for (const batch of batches) {
        const res = await this.expressions.evaluate({
          viewer: user,
          item,
          layerId: layerKey,
          expressions: Object.fromEntries(batch.map((e, k) => [`p${k}`, e.source])),
          ...(chunk ? { featureIds: chunk } : {}),
          limit,
        });
        res.expressions.forEach((e, k) => {
          const ph = batch[k]!;
          if (ph.index >= 0 && e.issues.length > 0 && !reported.has(ph.source)) {
            reported.add(ph.source);
            issues.push(
              `{{${ph.field ? ph.field.name : `= ${ph.source}`}}}: ${e.issues[0]!.message}`,
            );
          }
        });
        for (const row of res.rows) {
          const vals = out.get(row.id) ?? parsed.placeholders.map(() => null);
          batch.forEach((ph, k) => {
            if (ph.index < 0) return;
            const raw = row.values[k];
            const label = ph.field ? labels.get(ph.field.name)?.get(String(raw)) : undefined;
            vals[ph.index] = { text: label ?? reportText(raw) };
          });
          out.set(row.id, vals);
        }
      }
    }
    return out;
  }

  /** Code to label for fields with a pick list, so reports read like the form. */
  private async domainLabels(
    user: AuthUser,
    fields: FeatureField[],
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    for (const f of fields) {
      const d = f.domain;
      if (!d || out.has(f.name)) continue;
      if (d.type === 'coded-value') {
        out.set(f.name, new Map(d.values.map((v) => [String(v.code), v.label])));
      } else if (d.type === 'coded-value-ref') {
        try {
          const pl = await this.items.get(user, d.pickListItemId);
          const entries =
            (pl.data as { entries?: Array<{ code?: unknown; label?: unknown }> } | null)?.entries ??
            [];
          out.set(
            f.name,
            new Map(
              entries
                .filter((e) => typeof e.label === 'string')
                .map((e) => [String(e.code), e.label as string]),
            ),
          );
        } catch {
          // A pick list the requester cannot read leaves the codes.
        }
      }
    }
    return out;
  }

  /** Each feature's photo attachments as data: URIs. */
  private async photosFor(
    user: AuthUser,
    source: ReportSource,
    featureIds: string[],
    issues: string[],
  ): Promise<Map<string, ReportValue>> {
    const out = new Map<string, ReportValue>();
    if (featureIds.length === 0) return out;
    let access;
    try {
      access = await assertAttachmentAccess(
        this.items,
        this.sharing,
        user,
        source.itemId,
        source.layerKey,
        'download',
      );
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof NotFoundException) {
        issues.push('Photos are left out: they need download permission on the layer.');
        return out;
      }
      throw e;
    }
    const groups = await this.attachments.listForLayer(source.itemId, source.layerKey, {
      featureIds,
      access,
    });
    for (const { featureId, attachments: list } of groups) {
      const images: Array<{ src: string; caption: string }> = [];
      for (const att of list
        .filter((a) => a.mime.startsWith('image/'))
        .slice(0, MAX_PHOTOS_PER_FEATURE)) {
        if (att.sizeBytes > PHOTO_MAX_BYTES) continue;
        try {
          const { storageKey } = await this.attachments.getForDownload(
            source.itemId,
            source.layerKey,
            featureId,
            att.id,
          );
          const obj = await this.storage.streamObject(storageKey);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of obj.body) {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
            size += b.length;
            if (size > PHOTO_MAX_BYTES) throw new Error('too large');
            chunks.push(b);
          }
          const jpeg = await sharp(Buffer.concat(chunks), { failOn: 'none' })
            .rotate()
            .resize({
              width: PHOTO_MAX_PX,
              height: PHOTO_MAX_PX,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 75 })
            .toBuffer();
          images.push({
            src: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
            caption: att.fileName,
          });
        } catch (e) {
          this.log.warn(
            `Report photo ${att.id} skipped: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      out.set(featureId, { images });
    }
    return out;
  }

  /** A whole HTML document for the filled features. */
  document(title: string, features: FilledReport['features']): string {
    const sections = features.map((f) => `<section class="report">${f.html}</section>`).join('\n');
    const safeTitle = title.replace(/[<>&"]/g, '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>${REPORT_CSS}</style></head><body>${sections}</body></html>`;
  }

  /** Print a document to PDF in Chromium with scripts and network off. */
  async pdf(html: string, page: ReportTemplateData['page']): Promise<Buffer> {
    const endpoints = (process.env.CHROMIUM_WS_ENDPOINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (endpoints.length === 0) {
      throw new ServiceUnavailableException(
        'PDF output is not set up on this server (no Chromium endpoint).',
      );
    }
    if (this.activeRenders >= MAX_CONCURRENT_RENDERS) {
      throw new ServiceUnavailableException('The report service is busy. Try again in a minute.');
    }
    this.activeRenders += 1;
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: endpoints[Math.floor(Math.random() * endpoints.length)]!,
      });
      try {
        const tab = await browser.newPage();
        try {
          await tab.setJavaScriptEnabled(false);
          await tab.setRequestInterception(true);
          tab.on('request', (req) => {
            // Everything the report needs is inline.
            if (req.url().startsWith('data:') || req.url() === 'about:blank') void req.continue();
            else void req.abort();
          });
          await tab.setContent(html, { waitUntil: 'load', timeout: 60_000 });
          const pdf = await tab.pdf({
            format: PUPPETEER_FORMAT[page.size],
            landscape: page.orientation === 'landscape',
            printBackground: true,
            margin: { top: '0.6in', right: '0.6in', bottom: '0.7in', left: '0.6in' },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate:
              '<div style="width:100%;font-size:8pt;color:#666;text-align:center;font-family:Arial,sans-serif">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
            timeout: 120_000,
          });
          return Buffer.from(pdf);
        } finally {
          await tab.close().catch(() => undefined);
        }
      } finally {
        await browser.disconnect();
      }
    } finally {
      this.activeRenders -= 1;
    }
  }
}

/** A safe PDF file name. */
export function reportFileName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${cleaned || 'report'}.pdf`;
}
