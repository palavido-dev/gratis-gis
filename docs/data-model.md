# Data Model

The item/group/sharing model is the heart of GratisGIS. It follows patterns
familiar from cloud-GIS portals so admins and content authors can think in
familiar terms, but the implementation is open and portable.

## Entities

### Organization

A tenant. Every User, Group, and Item belongs to exactly one Organization.

| field | type | notes |
| --- | --- | --- |
| id | uuid (PK) | |
| slug | text unique | URL-safe (e.g. `acme`) |
| name | text | |
| created\_at | timestamptz | |

### User

Authoritative user record, synced from Keycloak on first login.

| field | type | notes |
| --- | --- | --- |
| id | uuid (PK) | matches Keycloak `sub` claim |
| org\_id | uuid → Organization | |
| username | text unique | |
| email | text | |
| full\_name | text | |
| org\_role | enum | `viewer` \| `contributor` \| `admin` |
| created\_at | timestamptz | |

### Group

| field | type | notes |
| --- | --- | --- |
| id | uuid (PK) | |
| org\_id | uuid → Organization | |
| title | text | |
| description | text | |
| access | enum | `private` \| `org` \| `public` |
| owner\_id | uuid → User | |
| created\_at | timestamptz | |

### GroupMember

| field | type | notes |
| --- | --- | --- |
| group\_id | uuid → Group | PK part |
| user\_id | uuid → User | PK part |
| role | enum | `member` \| `admin` |
| joined\_at | timestamptz | |

### Item

The universal content object. `type` tells consumers how to interpret
`data_json` and whether there's a storage side-car (a file in MinIO, a PostGIS
table, etc.).

| field | type | notes |
| --- | --- | --- |
| id | uuid (PK) | |
| org\_id | uuid → Organization | |
| owner\_id | uuid → User | |
| type | enum `ItemType` | see below |
| title | text | |
| description | text | |
| tags | text[] | |
| thumbnail\_url | text nullable | |
| data\_json | jsonb | type-specific config |
| storage\_ref | text nullable | MinIO key / table name / URL |
| access | enum | `private` \| `org` \| `public` (base level) |
| created\_at | timestamptz | |
| updated\_at | timestamptz | |

`access` is the baseline; `ItemShare` rows add group-level sharing on top.

### ItemShare

A row here grants a specific principal (a user *or* a group) access to an
Item beyond its baseline `access`. We use `(principal_type, principal_id)`
rather than two nullable FK columns so the composite PK has no nullable
members and the query path stays simple.

Note that sharing to a **specific user** (not just a group) is supported
natively, which is a deliberate improvement over portals that only allow
group-based sharing. For column-level and row-level scoping within a
feature-service, see the `feature-view` pattern in
[sharing-granularity.md](./sharing-granularity.md).

| field | type | notes |
| --- | --- | --- |
| item\_id | uuid → Item | PK part |
| principal\_type | enum | `user` \| `group`. PK part |
| principal\_id | uuid | references `user.id` or `group.id` per type. PK part |
| permission | enum | `view` \| `edit` \| `admin` |
| created\_at | timestamptz | |

Referential integrity between `principal_id` and the right table is
enforced by a trigger installed in an SQL migration (Prisma can't express
conditional FKs).

## ItemType enum

The names in this table are the early sketch. The create picker
and `packages/shared-types/src/item-types.ts` are the current
list. For what ships, the Status section in
[README.md](../README.md) wins. Dashboards are web-app layouts,
not a `dashboard` item. A `tool` item stores a named action or a
recipe. An optional workflow graph can live on a recipe. The
visual graph editor is not built. `report-template` is not built.

| value | payload in `data_json` | side-car storage |
| --- | --- | --- |
| `web-map` | basemap, layer refs, initial extent | - |
| `feature-service` | schema definition, renderer | PostGIS table |
| `form` | form schema (see `packages/form-schema`) | - |
| `form-submission-collection` | target form id, table ref | PostGIS table |
| `web-app` | app graph (widgets + bindings) | - |
| `report-template` | template markup | - |
| `dashboard` | panels + data bindings | - |
| `file` | file metadata (size, mime) | MinIO object |
| `layer-package` | style, schema | MinIO object |
| `tool` | named action or recipe (optional workflow graph) | - |
| `widget-package` | manifest of a tool-backed custom widget | - |

New types are added by registering them in
`packages/shared-types/src/item-types.ts`.

## Authorization Algorithm

Given a user `U` and an item `I`, access is granted iff any of:

1. `I.owner_id == U.id`
2. `I.access == 'public'`
3. `I.access == 'org' && I.org_id == U.org_id`
4. There exists an `ItemShare` row with `item_id = I.id` and either
   `(principal_type='user', principal_id=U.id)` or
   `(principal_type='group', principal_id âˆˆ groups(U))`.

`groups(U)` is the set of groups the user is a member of. Admin permission
on an item is granted to the owner and any org admin; edit is granted to
owner + org admin + users with `ItemShare.permission âˆˆ {edit, admin}`.

## Spatial Storage Layout

Each feature-service item creates a table like:

```sql
CREATE TABLE org_<org_id>.features_<item_id> (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES public.user(id),
  geom        geometry(Geometry, 4326),
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON org_<org_id>.features_<item_id> USING GIST (geom);
```

The schema-per-org pattern gives us hard tenant isolation and lets pg\_tileserv
publish per-schema without leaks.

## Form Submissions

A form collection is a feature-service of submissions. Each submission is a
row with `attrs` matching the form schema and (optionally) `geom` if the form
captured geometry. This is the *same* table shape as any other feature
collection, which means web maps and reports can consume submissions with no
special cases.

## Indexes

- `item(org_id, access)`: org scoping
- `item(owner_id)`. "my items"
- `item_share(principal_type, principal_id)`: share lookups by principal
- GIN on `item.tags` and `item.data_json` for search
