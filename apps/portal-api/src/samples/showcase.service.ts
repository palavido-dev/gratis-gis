// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadBatchesResumable } from './samples.service.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const gunzipAsync = promisify(gunzip);

import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ItemAccess, ItemType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { hasCapability } from '../auth/capabilities.js';
import { ItemsService } from '../items/items.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { deterministicSampleUuid } from './sample-uuid.js';
import type { SeedSampleDataResult } from './samples.service.js';

/**
 * "Load showcase dashboards" seeder.
 *
 * The definitions are the public demo's dashboards (storm events,
 * water quality, Elkins in 3D), with fresh ids per install. Every
 * item carries seedKind `sample:showcase-*`, so a second click
 * skips what is already there. Feature ids are hashed from the
 * layer id and the bundled feature id, same contract as the
 * Randolph sample.
 */

const FOLDER_KIND = 'sample:showcase-folder';

interface ShowcaseItem {
  key: string;
  seedKind: string;
  type: ItemType;
  title: string;
  description: string;
  tags: string[];
  access: ItemAccess;
  data: unknown;
  features: Record<string, string>;
}

interface ShowcaseCatalog {
  items: ShowcaseItem[];
}

interface Ensured {
  id: string;
  access: ItemAccess;
  wasCreated: boolean;
}

function showcaseDir(): string {
  const override = process.env.GRATIS_GIS_SHOWCASE_PATH;
  const candidates = [
    override ?? '',
    path.resolve(process.cwd(), 'content', 'samples', 'showcase'),
    path.resolve(
      process.cwd(),
      'apps',
      'portal-api',
      'content',
      'samples',
      'showcase',
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'catalog.json'))) return candidate;
  }
  return candidates[0]!;
}

function rewrite(data: unknown, ids: Map<string, string>): unknown {
  let text = JSON.stringify(data);
  for (const [key, id] of ids) {
    text = text.split(`{{${key}}}`).join(id);
  }
  return JSON.parse(text) as unknown;
}

@Injectable()
export class ShowcaseService {
  private readonly log = new Logger(ShowcaseService.name);
  private readonly inFlight = new Map<string, Promise<SeedSampleDataResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly features: DataLayerFeaturesService,
  ) {}

  async seed(user: AuthUser): Promise<SeedSampleDataResult> {
    if (!hasCapability(user, 'can_publish_items')) {
      throw new ForbiddenException(
        'Loading showcase dashboards requires the contributor or admin role.',
      );
    }
    let pending = this.inFlight.get(user.orgId);
    if (!pending) {
      pending = (async () => {
        try {
          return await this.run(user);
        } finally {
          this.inFlight.delete(user.orgId);
        }
      })();
      this.inFlight.set(user.orgId, pending);
    }
    return pending;
  }

  private async run(user: AuthUser): Promise<SeedSampleDataResult> {
    const dir = showcaseDir();
    const catalog = JSON.parse(
      await readFile(path.join(dir, 'catalog.json'), 'utf8'),
    ) as ShowcaseCatalog;
    const existing = await this.prisma.item.findMany({
      where: { orgId: user.orgId, seedKind: { startsWith: 'sample:showcase-' } },
      select: { id: true, seedKind: true, access: true },
    });
    const byKind = new Map(
      existing
        .filter((row) => typeof row.seedKind === 'string')
        .map((row) => [row.seedKind as string, row]),
    );
    const created: string[] = [];
    const skipped: string[] = [];
    const ids = new Map<string, string>();
    const made: Ensured[] = [];

    for (const spec of catalog.items) {
      const prior = byKind.get(spec.seedKind);
      let itemId: string;
      if (prior) {
        skipped.push(spec.seedKind);
        itemId = prior.id;
        made.push({ id: prior.id, access: prior.access, wasCreated: false });
      } else {
        itemId = deterministicSampleUuid(`item:${user.orgId}:${spec.seedKind}`);
        const row = await this.items.create(user, {
          id: itemId,
          type: spec.type,
          title: spec.title,
          description: spec.description,
          tags: spec.tags,
          data: rewrite(spec.data, ids) as Prisma.InputJsonValue,
          seedKind: spec.seedKind,
        });
        created.push(spec.seedKind);
        made.push({ id: row.id, access: row.access, wasCreated: true });
      }
      ids.set(spec.key, itemId);
      for (const [layerId, file] of Object.entries(spec.features)) {
        await this.loadFeatures(user, itemId, layerId, path.join(dir, file));
      }
    }

    const childIds = catalog.items.map((spec) => ids.get(spec.key)!);
    const folderPrior = byKind.get(FOLDER_KIND);
    if (folderPrior) {
      skipped.push(FOLDER_KIND);
    } else {
      const folderId = deterministicSampleUuid(
        `item:${user.orgId}:${FOLDER_KIND}`,
      );
      await this.items.create(user, {
        id: folderId,
        type: 'folder',
        title: 'Showcase dashboards',
        description:
          'Storm events, water quality, and Elkins in 3D, loaded from the built-in showcase. Safe to edit or delete.',
        tags: ['sample', 'showcase'],
        data: { version: 1, childItemIds: childIds },
        seedKind: FOLDER_KIND,
      });
      created.push(FOLDER_KIND);
      made.push({ id: folderId, access: 'private', wasCreated: true });
    }

    for (const spec of catalog.items) {
      if (spec.access === 'private') continue;
      const row = made.find((item) => item.id === ids.get(spec.key));
      // Only a freshly created item gets its tier. One that already
      // existed keeps what its owner set; re-running the seed must not
      // re-publish an item someone made private.
      if (!row || !row.wasCreated) continue;
      await this.items.update(user, row.id, { access: spec.access });
    }

    this.log.log(
      `Showcase seed for org=${user.orgId}: created ${created.length}, skipped ${skipped.length}`,
    );
    return { created, skipped };
  }

  private async loadFeatures(
    user: AuthUser,
    itemId: string,
    layerId: string,
    file: string,
  ): Promise<void> {
    // Inflated off the event loop. Batches resume where an earlier,
    // interrupted run stopped instead of leaving the layer partial.
    const parsed = JSON.parse(
      (await gunzipAsync(await readFile(file))).toString('utf8'),
    ) as { features?: Array<{ id?: string; properties?: unknown; geometry?: unknown }> };
    const features = parsed.features ?? [];
    await loadBatchesResumable({
      features: this.features,
      user,
      itemId,
      layerId,
      rows: features.map((feature, i) => ({
        globalId: deterministicSampleUuid(`${itemId}:${feature.id ?? i}`),
        geometry: feature.geometry as Record<string, unknown>,
        properties: (feature.properties ?? {}) as Record<string, unknown>,
      })),
    });
  }
}
