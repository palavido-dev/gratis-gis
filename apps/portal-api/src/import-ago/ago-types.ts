// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ArcGIS Online / Enterprise portal sharing-API response shapes.
 *
 * These mirror the documented JSON returned by ``/sharing/rest/...``
 * endpoints. We keep them narrow on purpose -- the migration only
 * needs the fields that map onto a portal item (title, type, owner,
 * tags, sharing) plus enough metadata to route the per-type
 * importer. The full AGO item shape has 50+ fields most of which
 * are AGO-internal and irrelevant to GratisGIS.
 *
 * Type discriminator is the ``type`` string. AGO's full type
 * vocabulary is large (Feature Service, Web Map, Web Mapping
 * Application, etc.); we accept any string here and let the
 * type-mapping table in import-ago decide whether to import.
 */

/** The portal-self response. We need ``user`` (current authed
 *  user) to walk their content; everything else is informational. */
export interface AgoPortalSelf {
  id?: string;
  name?: string;
  user?: {
    username?: string;
    fullName?: string;
    email?: string;
    orgId?: string;
  };
  /** AGO advertises its API version here; useful for adapting to
   *  future drift even though we don't gate on it today. */
  currentVersion?: string;
}

/**
 * One item summary returned by /sharing/rest/content/users/<user>
 * listings or /sharing/rest/search. Field set chosen to cover the
 * "I want to mirror this to GratisGIS" use case; sub-shapes
 * (e.g. service capabilities) come from a follow-up
 * /sharing/rest/content/items/<id> fetch when the importer needs
 * them.
 */
export interface AgoItem {
  id: string;
  /** AGO type discriminator. E.g. "Web Map", "Feature Service",
   *  "Form", "Web Mapping Application", "Vector Tile Service",
   *  "Image", "Code Attachment", "Document Link", "Service
   *  Definition", "Map Image Layer", "Map Service", etc. */
  type: string;
  /** "Feature Layer", "Table Layer", "Hosted Service" etc.
   *  Auxiliary classification AGO sometimes adds on top of `type`. */
  typeKeywords?: string[];
  title: string;
  /** AGO username of the owner. The migration maps it to a
   *  GratisGIS user when one exists with the same username, else
   *  attributes to the import operator. */
  owner: string;
  /** Long-form description (may include HTML). */
  description?: string | null;
  /** Short summary line (snippet in AGO terms). */
  snippet?: string | null;
  tags?: string[];
  /** AGO sharing scope. ``private`` -> personal,
   *  ``org`` -> organization, ``public`` -> public. The string
   *  matches GratisGIS's own access enum so it passes through.
   *  ``shared`` (with specific groups) is a fourth value that
   *  AGO emits but we collapse to ``org`` on import. */
  access: 'private' | 'org' | 'public' | 'shared';
  /** Folder this item lives in for its owner. Null at the root.
   *  AGO folder ids look like 7-char hex; we round-trip them
   *  through a string. */
  ownerFolder?: string | null;
  /** Service URL for hosted services (Feature/Map/Vector Tile).
   *  Empty for non-service items (Web Map, Form, etc.). */
  url?: string | null;
  /** Creation + modification timestamps (epoch ms). Carried
   *  through so the import preserves provenance. */
  created?: number;
  modified?: number;
  /** Item-level thumbnail filename, relative to
   *  /sharing/rest/content/items/<id>/info/<filename>. */
  thumbnail?: string | null;
}

/**
 * A single folder under a user's content. AGO returns these in
 * the user-content listing.
 */
export interface AgoFolder {
  id: string;
  title: string;
  /** Epoch ms when the folder was created. */
  created?: number;
  username: string;
}

/**
 * Response shape for /sharing/rest/content/users/<user>/. The
 * root listing carries the items directly visible (no folder)
 * plus a list of folders. Sub-folder content is fetched per
 * folder with /sharing/rest/content/users/<user>/<folderId>/.
 */
export interface AgoUserContentResponse {
  username: string;
  total?: number;
  start?: number;
  num?: number;
  nextStart?: number;
  /** Folders the user owns. May be undefined when the user has
   *  no folders at all. */
  folders?: AgoFolder[];
  /** Items directly under the user's root or under the
   *  requested folder. */
  items?: AgoItem[];
}

/**
 * AGO error response shape. The portal returns 200 OK with an
 * ``error`` object on failure; we detect and convert to a typed
 * exception in the client.
 */
export interface AgoErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    messageCode?: string;
    details?: string[];
  };
}

/** A member of an ArcGIS organization, from /portals/self/users. */
export interface AgoOrgUser {
  username: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** org_admin, org_publisher or org_user. */
  role?: string;
  /** Custom or built-in role id; iAAAAAAAAAAAAAAA is Viewer. */
  roleId?: string;
  disabled?: boolean;
}

/** An ArcGIS group. */
export interface AgoGroup {
  id: string;
  title: string;
  description?: string | null;
  snippet?: string | null;
  access?: string;
  owner?: string;
}
