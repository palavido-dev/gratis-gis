import type { ItemId, UserId, OrgId, ISODateString } from './ids';
import type { ItemAccess, SharePermission } from './sharing';
import type { ItemType } from './item-types';

export type PrincipalType = 'user' | 'group';

export interface Item<TData = unknown> {
  id: ItemId;
  orgId: OrgId;
  ownerId: UserId;
  type: ItemType;
  title: string;
  description: string;
  tags: string[];
  thumbnailUrl: string | null;
  data: TData;
  storageRef: string | null;
  access: ItemAccess;
  /**
   * Open-data license for this item. SPDX identifier (e.g.
   * "CC-BY-4.0"), a URL, or a free-form string. Null = no license
   * recorded; consumers of the DCAT /public/catalog.json feed
   * should treat absence as "rights reserved".
   */
  license: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /**
   * Soft-delete timestamp. Non-null means the item is in the recycle
   * bin and will be permanently removed after the retention window.
   * See /docs/soft-delete.md.
   */
  deletedAt: ISODateString | null;
}

export interface ItemShare {
  itemId: ItemId;
  principalType: PrincipalType;
  /** Either a UserId or a GroupId depending on principalType. */
  principalId: string;
  permission: SharePermission;
  createdAt: ISODateString;
  /**
   * Optional inline GeoJSON polygon / multipolygon (EPSG:4326) that
   * restricts what this principal sees on the item. Null / undefined
   * means "no inline polygon". Mutually exclusive with `geoBoundaryId`
   * at the API layer.
   */
  geoLimit?: unknown | null;
  /**
   * Optional reference to a geo_boundary item whose geometry supplies
   * the clip. Mutually exclusive with `geoLimit`. The API resolves the
   * geometry at request time so edits to the boundary flow through
   * to every share that points at it without re-saving.
   */
  geoBoundaryId?: string | null;
  /**
   * Optional expiry timestamp (#84). Null / undefined means the
   * share never expires (default). When set and in the past, the
   * share is filtered out at request time and eventually swept by
   * the housekeeping cron. ISO date string on the wire.
   */
  expiresAt?: ISODateString | null;
}

/**
 * Item joined with its share rows. Returned by list + get endpoints so
 * UIs can render sharing indicators (and the full sharing panel on
 * detail pages) without a second round-trip per item.
 */
export type ItemWithShares<TData = unknown> = Item<TData> & {
  shares: ItemShare[];
  /**
   * Lean owner projection included on list responses so the items
   * page can render an Owner column without N+1 lookups. Absent on
   * endpoints that don't join the user table (e.g. per-item GET has
   * it too, but specialised responses might not).
   */
  owner?: {
    id: string;
    username: string;
    fullName: string;
    avatarUrl: string | null;
  } | null;
};

/** Input shape for creating a new Item via the API. */
export interface CreateItemInput<TData = unknown> {
  type: ItemType;
  title: string;
  description?: string;
  tags?: string[];
  data: TData;
  access?: ItemAccess;
}
