import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { ItemAccess, ItemType, Prisma, PrincipalType, SharePermission } from '@prisma/client';
import { ITEM_TYPES } from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { CreateItemInput, UpdateItemInput } from './items.service.js';
import { ItemsService } from './items.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';

class CreateItemDto {
  @IsEnum(ITEM_TYPES) type!: ItemType;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  // Typed as JSON-compatible at the Prisma layer; validated at runtime by @IsObject.
  @IsObject() data!: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL minted by StorageService when the user uploads a custom
  // thumbnail during create. Optional; null/omitted falls back to the
  // auto-generated initial badge.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  // Open-data license string (SPDX id, URL, or free-form). Null on
  // create means "not recorded"; DCAT consumers treat absence as
  // "rights reserved".
  @IsOptional() @IsString() @MaxLength(500) license?: string | null;
}

class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsObject() data?: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL produced by StorageService after the browser PUT completes.
  // Pass null to clear a previously-set thumbnail.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  // Open-data license. SPDX id (CC-BY-4.0), URL, or free-form.
  // Pass null to clear a previously-set license.
  @IsOptional() @IsString() @MaxLength(500) license?: string | null;
}

class ReassignOwnerDto {
  @IsUUID('loose') newOwnerId!: string;
  // null explicitly clears / skips the courtesy share for the
  // previous owner; 'view' | 'download' | 'edit' | 'admin' creates / updates one;
  // omitted = no courtesy share created.
  @IsOptional()
  @IsEnum(['view', 'download', 'edit', 'admin'])
  keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
}

class BulkReassignDto {
  @IsArray() @IsUUID('loose', { each: true }) itemIds!: string[];
  @IsUUID('loose') newOwnerId!: string;
  @IsOptional()
  @IsEnum(['view', 'download', 'edit', 'admin'])
  keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
}

class ShareDto {
  @IsEnum(['user', 'group']) principalType!: PrincipalType;
  // 'loose' accepts any 8-4-4-4-12 hex string. Real UUIDs coming from Keycloak
// and Prisma's @default(uuid()) are always v4, but seed fixtures use
// readable all-same-char UUIDs (aaaa..., bbbb...) for debugging that fail
// strict v4 validation. The DB-level FK check is our real integrity
// guarantee via assertPrincipalExists().
@IsUUID('loose') principalId!: string;
  @IsOptional() @IsEnum(['view', 'download', 'edit', 'admin']) permission?: SharePermission;
  /**
   * Inline GeoJSON polygon (EPSG:4326) that clips what this principal
   * can see on the item. Pass `null` to clear. Omit the field to
   * leave the existing limit untouched. Mutually exclusive with
   * `geoBoundaryId` at the service layer.
   */
  @IsOptional() geoLimit?: unknown | null;
  /**
   * UUID of a geo_boundary item whose geometry supplies the clip.
   * Pass `null` to clear; omit to leave untouched. Mutually
   * exclusive with `geoLimit`. Caller is responsible for ensuring
   * the referenced item is a `geo_boundary` and visible to the
   * grantee; the sharing service does not validate at write time
   * but a missing / wrong-typed target is treated as "no clip" at
   * read time so a deleted boundary cannot silently expand access.
   */
  @IsOptional() @IsUUID('loose') geoBoundaryId?: string | null;
  /**
   * Row-level scope for this share (#40). `'all'` (default) means
   * the principal sees every row in the layer; `'own'` narrows to
   * features they themselves created (`created_by = principal.id`).
   * Pairs with geoLimit / geoBoundaryId so a single share can be
   * "edit only your features in your county". Admins / item owner
   * are exempt regardless. Omit to leave existing scope untouched.
   */
  @IsOptional() @IsEnum(['all', 'own']) rowScope?: 'all' | 'own';
}

@ApiTags('items')
@ApiBearerAuth()
@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly snapshots: DataSnapshotService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('mine') mine?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('ownerId') ownerId?: string,
    @Query('bbox') bbox?: string,
    @Query('buffer') buffer?: string,
    @Query('lite') lite?: string,
  ) {
    // Build opts without explicit-undefined keys so `exactOptionalPropertyTypes`
    // is satisfied. Passing `{ type: undefined }` is not the same as omitting it.
    const opts: {
      mine?: boolean;
      type?: ItemType | ItemType[];
      q?: string;
      ownerId?: string;
      bbox?: [number, number, number, number];
      bufferKm?: number;
      lite?: boolean;
    } = {};
    if (mine === 'true') opts.mine = true;
    // ?type accepts a single ItemType or a comma-separated list.
    // Multi-type lets callers (e.g. the Add Layer dialog) pull both
    // data_layer and arcgis_service in one round-trip instead of
    // firing two parallel requests that each pay the auth-sync cost.
    // Each token is validated against ITEM_TYPES so a malformed
    // query stays an empty filter (Prisma rejects bad enum values).
    if (type !== undefined) {
      const tokens = type
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const valid = tokens.filter(
        (t): t is ItemType => (ITEM_TYPES as readonly string[]).includes(t),
      );
      if (valid.length === 1) opts.type = valid[0]!;
      else if (valid.length > 1) opts.type = valid;
      // empty / all-invalid: leave opts.type unset; the caller gets the
      // unfiltered list back, which matches the no-?type behaviour.
    }
    if (q !== undefined) opts.q = q;
    if (ownerId !== undefined) opts.ownerId = ownerId;
    if (lite === '1' || lite === 'true') opts.lite = true;
    if (bbox !== undefined) {
      const parts = bbox.split(',').map(Number);
      if (
        parts.length === 4 &&
        parts.every((n) => Number.isFinite(n))
      ) {
        const [w, s, e, n] = parts as [number, number, number, number];
        opts.bbox = [w, s, e, n];
      }
    }
    if (buffer !== undefined) {
      const km = Number(buffer);
      if (Number.isFinite(km) && km >= 0) opts.bufferKm = km;
    }
    return this.items.list(user, opts);
  }

  // NOTE: /items/trash must be declared before /items/:id so Nest's
  // route matcher doesn't try to treat "trash" as an id parameter.
  @Get('trash')
  listTrash(@CurrentUser() user: AuthUser) {
    return this.items.listTrash(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.get(user, id);
  }

  /** Items that THIS item references (e.g. feature services powering
   *  the layers of a web map). */
  @Get(':id/dependencies')
  dependencies(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.listDependencies(user, id);
  }

  /**
   * Resolve a folder's children into the visible item rows. Drops:
   *  - items the caller cannot see (per-item authz)
   *  - items in the trash (deletedAt set)
   *  - dangling references to items that no longer exist
   * Returns the surviving items in the order specified by the folder's
   * childItemIds. See docs/folders.md.
   */
  @Get(':id/folder-contents')
  folderContents(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.items.listFolderContents(user, id);
  }

  /**
   * Inherited shares for an item: shares from any folder that
   * contains this item (directly or transitively, stopping at
   * folders that opt out of inheritance), tagged with the
   * originating folder so the share dialog can render
   * "Inherited from Project A" captions. (#44 phase 1c slice 3c)
   */
  @Get(':id/inherited-shares')
  async inheritedShares(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    // Authz: caller must be able to read the item (which already
    // covers ownership / public / org / share-grant paths). The
    // helper itself doesn't gate on the caller; we gate here.
    await this.items.get(user, id);
    return this.items.listInheritedShares(id);
  }

  /** Items that reference THIS one. Pass ?transitive=true to walk
   *  further (e.g. a layer used by a map used by a dashboard). */
  @Get(':id/dependents')
  dependents(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('transitive') transitive?: string,
  ) {
    return this.items.listDependents(user, id, {
      transitive: transitive === 'true' || transitive === '1',
    });
  }

  /**
   * GeoJSON-only view of a data_layer item. Handles both v1 (inline
   * JSON) and v2 (PostGIS) storage transparently.
   *
   * For v2 items, accepts ?bbox=minX,minY,maxX,maxY and ?at=<ISO timestamp>
   * for spatial filtering and point-in-time queries respectively.
   *
   * Visibility goes through the same sharing check as the regular get.
   */
  @Get(':id/geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    // Use conditional spread (not `undefined` values) to play nicely
    // with exactOptionalPropertyTypes; the destructure also narrows
    // parts[0..3] from `number | undefined` down to `number`, which
    // is what the service signature needs.
    const opts: { bbox?: [number, number, number, number]; at?: string } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        const [minX, minY, maxX, maxY] = parts as [number, number, number, number];
        opts.bbox = [minX, minY, maxX, maxY];
      }
    }
    if (at) opts.at = at;
    return this.items.getGeoJson(user, id, opts);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateItemDto) {
    return this.items.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.remove(user, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.restore(user, id);
  }

  /**
   * Permanent delete. Distinct verb+path from soft-delete so a bad client
   * retrying a DELETE can't accidentally skip the trash step.
   */
  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.purge(user, id);
  }

  @Post(':id/share')
  share(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.share(user, id, dto);
  }

  @Delete(':id/share')
  unshare(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.unshare(user, id, dto);
  }

  @Patch(':id/owner')
  reassignOwner(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReassignOwnerDto,
  ) {
    const patch: {
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    } = { newOwnerId: dto.newOwnerId };
    if (dto.keepPreviousOwnerAccess !== undefined) {
      patch.keepPreviousOwnerAccess = dto.keepPreviousOwnerAccess;
    }
    return this.items.reassignOwner(user, id, patch);
  }

  /**
   * List data-replace snapshots for an item. The payload doesn't
   * include the full data blob (just metadata) so the history
   * panel can render cheaply. Caller must have edit access
   * snapshots are authorship history, not public.
   */
  @Get(':id/snapshots')
  async listSnapshots(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.items.assertCanEdit(user, id);
    return this.snapshots.list(id);
  }

  /**
   * Revert an item's data to a prior snapshot. Captures the current
   * state as a fresh snapshot first, so un-revert is possible for
   * the retention window. Caller must have edit access.
   *
   * The snapshotId must belong to the item in the URL: we don't want
   * /items/A/snapshots/{snap-from-B}/revert to quietly mutate B just
   * because the caller happens to have edit access on A.
   */
  @Post(':id/snapshots/:snapshotId/revert')
  async revertSnapshot(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    await this.items.assertCanEdit(user, id);
    const snap = await this.snapshots.get(snapshotId);
    if (snap.itemId !== id) {
      throw new BadRequestException(
        'Snapshot does not belong to this item',
      );
    }
    return this.snapshots.revert(snapshotId, user.id);
  }

  @Post('bulk/reassign-owner')
  bulkReassign(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkReassignDto,
  ) {
    const patch: {
      itemIds: string[];
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    } = { itemIds: dto.itemIds, newOwnerId: dto.newOwnerId };
    if (dto.keepPreviousOwnerAccess !== undefined) {
      patch.keepPreviousOwnerAccess = dto.keepPreviousOwnerAccess;
    }
    return this.items.bulkReassignOwner(user, patch);
  }
}
