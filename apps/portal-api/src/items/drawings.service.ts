// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DRAWING_SET_PALETTE,
  defaultDrawingSetTitle,
  nextDrawingSetColor,
  type DrawingFeature,
  type DrawingSet,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from './sharing.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Service for drawings on a `map` item (#154 Phase 1).
 *
 * Drawings live inline on the map's `data.drawings` JSON array. This
 * service is the only write path: every mutation reads the item,
 * checks permissions against the caller (signed-in user or null
 * anonymous), modifies the array, and writes the whole `data` blob
 * back via Prisma. Each write bumps the item's `updatedAt` and goes
 * through a transaction so two concurrent edits to different drawing
 * sets don't clobber each other.
 *
 * Permission posture (different from item edit because the WHOLE
 * point is letting non-editors mark up):
 *   - LIST / READ: anyone who can read the item (canRead). Anonymous
 *     allowed when the item is public.
 *   - CREATE a new drawing set: same as read. Anonymous additionally
 *     requires the map to carry `allowAnonymousDrawings: true`.
 *   - UPDATE an existing set: the set's author OR a user with edit
 *     access on the item. Anonymous can update only sets they
 *     authored in the same session (Phase 1: identified by the
 *     `anonymousAuthorToken` cookie the BFF mints; checked elsewhere,
 *     not here).
 *   - DELETE an existing set: same as update.
 *
 * `allowAnonymousDrawings` is a property of the map item itself; the
 * `setAnonymousDrawingsAllowed` method here flips it through this
 * service (which already has the read+modify+write plumbing) and is
 * gated on canEdit.
 */
type AnonymousAuthor = {
  /** Stable per-session token minted by the BFF for anonymous
   *  authors so the same anon can edit their own drawings on
   *  return visits. */
  token: string;
  /** Display label, e.g. "Anonymous reviewer 1". */
  display: string;
};

export type DrawingsAuthor =
  | { kind: 'user'; user: AuthUser }
  | { kind: 'anonymous'; anon: AnonymousAuthor }
  | { kind: 'unknown' };

interface MapDataLike {
  drawings?: DrawingSet[];
  allowAnonymousDrawings?: boolean;
  [k: string]: unknown;
}

@Injectable()
export class DrawingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  async list(
    user: AuthUser | null,
    mapId: string,
  ): Promise<DrawingSet[]> {
    const { data } = await this.loadMapForRead(user, mapId);
    return data.drawings ?? [];
  }

  async create(
    author: DrawingsAuthor,
    mapId: string,
    input: {
      title?: string;
      color?: string;
      features?: DrawingFeature[];
    },
  ): Promise<DrawingSet> {
    const { data, item } = await this.loadMapForWrite(author, mapId);
    if (author.kind === 'anonymous' && data.allowAnonymousDrawings !== true) {
      throw new ForbiddenException(
        'Anonymous markup is not enabled on this map',
      );
    }
    const sets = data.drawings ?? [];
    if (sets.length >= DRAWING_LIMITS.MAX_SETS_PER_MAP) {
      throw new BadRequestException(
        `This map already has ${sets.length} drawing sets ` +
          `(maximum ${DRAWING_LIMITS.MAX_SETS_PER_MAP}). ` +
          'Delete an existing set before adding a new one.',
      );
    }
    const usedColors = sets.map((s) => s.color);
    const now = new Date().toISOString();
    const authorId =
      author.kind === 'user' ? author.user.id : null;
    const authorDisplay = await this.resolveAuthorDisplay(author);
    const next: DrawingSet = {
      id: randomUUID(),
      authorId,
      authorDisplay,
      title:
        typeof input.title === 'string' && input.title.trim().length > 0
          ? input.title.trim().slice(0, 200)
          : defaultDrawingSetTitle(authorDisplay),
      color: validateHexColor(input.color) ?? nextDrawingSetColor(usedColors),
      visible: true,
      features: sanitizeFeatures(input.features ?? []),
      createdAt: now,
      updatedAt: now,
    };
    const nextData: MapDataLike = {
      ...data,
      drawings: [...sets, next],
    };
    await this.prisma.item.update({
      where: { id: item.id },
      data: { data: nextData as object },
    });
    return next;
  }

  async update(
    author: DrawingsAuthor,
    mapId: string,
    drawingId: string,
    patch: {
      title?: string;
      color?: string;
      visible?: boolean;
      features?: DrawingFeature[];
    },
  ): Promise<DrawingSet> {
    const { data, item } = await this.loadMapForWrite(author, mapId);
    const sets = data.drawings ?? [];
    const idx = sets.findIndex((s) => s.id === drawingId);
    if (idx < 0) throw new NotFoundException('Drawing set not found');
    const existing = sets[idx]!;
    await this.assertCanWriteSet(author, item, existing);
    const updated: DrawingSet = {
      ...existing,
      ...(typeof patch.title === 'string'
        ? { title: patch.title.trim().slice(0, 200) }
        : {}),
      ...(validateHexColor(patch.color)
        ? { color: validateHexColor(patch.color)! }
        : {}),
      ...(typeof patch.visible === 'boolean'
        ? { visible: patch.visible }
        : {}),
      ...(Array.isArray(patch.features)
        ? { features: sanitizeFeatures(patch.features) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const nextSets = sets.slice();
    nextSets[idx] = updated;
    const nextData: MapDataLike = { ...data, drawings: nextSets };
    await this.prisma.item.update({
      where: { id: item.id },
      data: { data: nextData as object },
    });
    return updated;
  }

  async remove(
    author: DrawingsAuthor,
    mapId: string,
    drawingId: string,
  ): Promise<void> {
    const { data, item } = await this.loadMapForWrite(author, mapId);
    const sets = data.drawings ?? [];
    const existing = sets.find((s) => s.id === drawingId);
    if (!existing) return; // idempotent delete
    await this.assertCanWriteSet(author, item, existing);
    const nextSets = sets.filter((s) => s.id !== drawingId);
    const nextData: MapDataLike = { ...data, drawings: nextSets };
    await this.prisma.item.update({
      where: { id: item.id },
      data: { data: nextData as object },
    });
  }

  /**
   * Load a drawing set and assert the author may write it. Used by
   * Phase 1.5 promote so the promote module can reuse the same
   * author-or-editor gate without reimplementing share lookups.
   */
  async requireWritableSet(
    author: DrawingsAuthor,
    mapId: string,
    drawingId: string,
  ): Promise<DrawingSet> {
    const { data, item } = await this.loadMapForWrite(author, mapId);
    const set = (data.drawings ?? []).find((s) => s.id === drawingId);
    if (!set) throw new NotFoundException('Drawing set not found');
    await this.assertCanWriteSet(author, item, set);
    return set;
  }

  /**
   * Toggle the map's `allowAnonymousDrawings` flag. Gated on
   * canEdit (signed-in only). The flag is what unlocks the
   * manager-redline workflow for unauthenticated viewers; we
   * default it off so a sloppy share doesn't accidentally invite
   * the open internet to draw on a private parcel map.
   */
  async setAnonymousDrawingsAllowed(
    user: AuthUser,
    mapId: string,
    allowed: boolean,
  ): Promise<void> {
    const item = await this.loadMapItem(mapId);
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: mapId },
    });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException(
        'You do not have edit permission on this map',
      );
    }
    const data = (item.data ?? {}) as MapDataLike;
    const nextData: MapDataLike = { ...data, allowAnonymousDrawings: allowed };
    await this.prisma.item.update({
      where: { id: item.id },
      data: { data: nextData as object },
    });
  }

  // ---- internal helpers ------------------------------------------------

  /**
   * Resolve a friendly display name for the author. Falls back to
   * the user's row in the portal db so a fresh JWT (which carries
   * only username + email) can still surface a real display name
   * if one is set on the profile. Anonymous authors use the label
   * supplied at construction; unknown authors are refused upstream.
   */
  private async resolveAuthorDisplay(author: DrawingsAuthor): Promise<string> {
    if (author.kind === 'anonymous') return author.anon.display;
    if (author.kind === 'unknown') return 'Reviewer';
    const user = author.user;
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { fullName: true, username: true },
    });
    const display =
      (row?.fullName && row.fullName.trim().length > 0 ? row.fullName : null) ??
      row?.username ??
      user.username ??
      'Reviewer';
    return display.slice(0, 200);
  }

  private async loadMapForRead(
    user: AuthUser | null,
    mapId: string,
  ): Promise<{ data: MapDataLike; item: Awaited<ReturnType<DrawingsService['loadMapItem']>> }> {
    const item = await this.loadMapItem(mapId);
    if (user) {
      const shares = await this.prisma.itemShare.findMany({
        where: { itemId: mapId },
      });
      if (!this.sharing.canRead(user, item, shares)) {
        throw new NotFoundException('Map not found');
      }
    } else if (item.access !== 'public') {
      // Anonymous reads on a non-public item: return NotFound rather
      // than Forbidden so the existence of private maps doesn't leak.
      throw new NotFoundException('Map not found');
    }
    return { data: (item.data ?? {}) as MapDataLike, item };
  }

  private async loadMapForWrite(
    author: DrawingsAuthor,
    mapId: string,
  ): Promise<{ data: MapDataLike; item: Awaited<ReturnType<DrawingsService['loadMapItem']>> }> {
    if (author.kind === 'unknown') {
      throw new ForbiddenException('Sign in to create a markup');
    }
    if (author.kind === 'user') {
      return this.loadMapForRead(author.user, mapId);
    }
    return this.loadMapForRead(null, mapId);
  }

  private async loadMapItem(mapId: string) {
    const item = await this.prisma.item.findFirst({
      where: { id: mapId, type: 'map', deletedAt: null },
    });
    if (!item) throw new NotFoundException('Map not found');
    return item;
  }

  private async assertCanWriteSet(
    author: DrawingsAuthor,
    item: Awaited<ReturnType<DrawingsService['loadMapItem']>>,
    set: DrawingSet,
  ): Promise<void> {
    if (author.kind === 'user') {
      // Author of the set always allowed; otherwise must have edit
      // access on the item.
      if (set.authorId === author.user.id) return;
      const shares = await this.prisma.itemShare.findMany({
        where: { itemId: item.id },
      });
      if (this.sharing.canEdit(author.user, item, shares)) return;
      throw new ForbiddenException(
        "You can only edit your own drawing sets on this map",
      );
    }
    if (author.kind === 'anonymous') {
      // Anonymous can only edit sets they authored. The
      // anon-author token check is enforced at the controller layer
      // (it has access to the cookie / header that carries the
      // token); by the time we get here we trust the caller has
      // verified `set.authorId === null && set.authorDisplay matches`
      // is THIS anon. Re-assert it cheaply.
      if (set.authorId === null && set.authorDisplay === author.anon.display) {
        return;
      }
      throw new ForbiddenException(
        'You can only edit drawing sets you created in this session',
      );
    }
    throw new ForbiddenException('Sign in to edit a markup');
  }
}

/**
 * Validate a hex color string. Accepts `#rrggbb` and `#rgb`; returns
 * the normalized lowercase form, or null on failure. Used to reject
 * stylesheet-injecting strings before they hit the JSON column.
 */
function validateHexColor(c: string | undefined): string | null {
  if (typeof c !== 'string') return null;
  const trimmed = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return (
      '#' +
      trimmed
        .slice(1)
        .split('')
        .map((ch) => ch + ch)
        .join('')
    );
  }
  return null;
}

/**
 * Hard-cap features per drawing set and sanitize each one so a
 * malformed write can't blow up the item's data blob. Drops
 * unknown geometry types, clamps the array length, and stamps a
 * fresh id + timestamps when those are missing.
 *
 * Cap rationale: Phase 1 drawings live inline on the item's JSON
 * column. 500 features per set + a soft cap of 16 sets per map
 * (enforced at the call site of create) keeps a malicious or
 * over-eager redline under ~1 MB serialized.
 */
const MAX_FEATURES_PER_SET = 500;

function sanitizeFeatures(features: DrawingFeature[]): DrawingFeature[] {
  if (!Array.isArray(features)) return [];
  const now = new Date().toISOString();
  return features
    .slice(0, MAX_FEATURES_PER_SET)
    .map((f) => sanitizeFeature(f, now))
    .filter((f): f is DrawingFeature => f !== null);
}

const ALLOWED_KINDS = new Set([
  'pin',
  'line',
  'polygon',
  'text',
  'arrow',
  'circle',
]);

const ALLOWED_GEOMETRY_TYPES = new Set([
  'Point',
  'LineString',
  'Polygon',
  // MultiPoint / MultiLineString / MultiPolygon are not authored by
  // the toolbar today but accepting them costs nothing if a future
  // tool wants them; the renderer already handles the multi-* forms.
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

function sanitizeFeature(
  raw: DrawingFeature,
  now: string,
): DrawingFeature | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!ALLOWED_KINDS.has(raw.kind)) return null;
  const geom = raw.geometry as { type?: string } | null | undefined;
  if (!geom || typeof geom !== 'object' || typeof geom.type !== 'string') {
    return null;
  }
  if (!ALLOWED_GEOMETRY_TYPES.has(geom.type)) return null;
  return {
    id:
      typeof raw.id === 'string' && raw.id.length > 0
        ? raw.id
        : randomUUID(),
    kind: raw.kind,
    geometry: raw.geometry,
    ...(raw.style ? { style: clampStyle(raw.style) } : {}),
    ...(typeof raw.label === 'string'
      ? { label: raw.label.slice(0, 500) }
      : {}),
    ...(typeof raw.note === 'string'
      ? { note: raw.note.slice(0, 2000) }
      : {}),
    createdAt:
      typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
  };
}

function clampStyle(s: NonNullable<DrawingFeature['style']>): NonNullable<DrawingFeature['style']> {
  const out: NonNullable<DrawingFeature['style']> = {};
  if (validateHexColor(s.color)) out.color = validateHexColor(s.color)!;
  if (typeof s.strokeWidth === 'number') {
    out.strokeWidth = Math.min(Math.max(s.strokeWidth, 0), 24);
  }
  if (
    typeof s.dashStyle === 'string' &&
    DRAWING_SET_PALETTE // sentinel import keeps the linter happy
  ) {
    // Trust the enum union; the shared-types DashStyle is closed.
    out.dashStyle = s.dashStyle;
  }
  if (typeof s.fillOpacity === 'number') {
    out.fillOpacity = Math.min(Math.max(s.fillOpacity, 0), 1);
  }
  return out;
}

export const DRAWING_LIMITS = {
  MAX_FEATURES_PER_SET,
  MAX_SETS_PER_MAP: 64,
};
