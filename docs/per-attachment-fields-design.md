# Per-attachment custom fields (#158) - design doc

## DECISION (2026-04-29): superseded by related-table pattern

After reviewing this doc, the conclusion is that all three storage
options below (JSONB on FeatureAttachment, EAV side-table, dedicated
`fa_*` table) are over-engineered. The right answer uses primitives
GratisGIS already has:

> If each photo carries metadata, the metadata belongs on a related
> "event" row, not on the attachment row. The attachment is just
> evidence stapled to the event.

Rewriting the four motivating examples in this pattern:

* **Utility pole inspection.** Pole (parent feature) -> Inspections
  (related data_layer: caption, photographer, capture timestamp,
  GPS-at-capture, shot direction) -> Photos (standard attachment
  table, but parented to the Inspection row, not the Pole row).
* **Site visit.** Parcel -> Visits (phase, elevation, weather notes)
  -> Photos on the Visit.
* **Wildlife survey.** Transect waypoint -> Observations (species,
  count, behavior code) -> Photos on the Observation.
* **Damage assessment.** Building -> Damage entries (category 1-5,
  affected component, repair priority) -> Photos on the Entry.

In every case, the "per-photo" metadata is actually per-event
metadata. The event is a real-world thing (an inspection happened,
a visit happened, an observation happened), distinct from the
parent feature. Modeling it as a related row instead of as
attachment-row columns is correct on every axis:

1. **Queryable like any feature data.** "Show me all moderate-damage
   entries from last week" is a normal feature query against the
   Damage Entries data_layer, not a JSONB field extraction.
2. **Multi-photo per event is free.** The attachment table is
   already 1:N against any feature row. Stick the photos on the
   Inspection row instead of the Pole row and one inspection
   trivially has many photos.
3. **Sharing / editor tracking / geo-limits / row scope work.**
   Because the Inspections layer is just a normal data_layer, every
   piece of access-control plumbing we've already built applies.
   None of that exists for "JSONB on attachment rows".
4. **Zero new primitives.** Related tables, related layers, and
   attachments all exist today. The form designer already supports
   repeating groups. We don't need to invent a parallel schema
   system one level below the one we already have.
5. **Mental model lines up with the real world.** "One inspection
   has many photos" is a real domain concept. "This attachment has
   six custom fields attached to it" is an implementation artifact
   that leaks into the user's understanding of their own data.

### What this means for the work

* `FeatureAttachment` stays exactly as it is. No JSONB column, no
  EAV side-table, no per-data_layer `fa_*` shadow table. The three
  storage options below are filed under "rejected alternatives".
* `#158` (data_layer detail: split attachment-table columns) is
  effectively closed: there are no per-attachment columns to split,
  because per-attachment metadata is just a related layer the user
  navigates into.
* `#157` (form designer's "per-attachment fields" affordance) needs
  reframing. The current affordance points users at the wrong
  pattern. Instead it should be a "create related event layer"
  shortcut on the form designer: when an author drops an attachment
  question into a form and wants per-photo metadata, the right
  next step is "wrap this in a related Inspections layer", not
  "drop more questions into the attachment slot". Follow-up task
  to be written.
* We may want a one-click wizard on the data_layer detail page:
  "Add an event-tracking related layer" that creates the related
  data_layer, the FK relationship, and (optionally) seeds an
  attachment-on-event affordance. That makes the pattern just as
  fast as the rejected per-attachment-columns approach in the
  common case, without paying the schema cost.

The rest of this doc is preserved as the rationale for *why* the
related-table approach beat the alternatives, but is no longer the
plan of record.

---

## Why this exists (original framing)

PR #157 ("surface 'per-attachment fields' affordance on attachment
groups") added a UI affordance in the form designer that says, in
effect: "drop questions into a Photos repeat group and they'll be
captured per-attachment alongside the file (caption, taken-by,
GPS-at-capture, etc.)". The PR body described those questions as
"becoming columns on the attachment table".

That description was aspirational, not accurate. The
`feature_attachment` Prisma model is fixed:

```
model FeatureAttachment {
  id         String
  itemId     String
  layerId    String
  featureId  String
  fileName   String
  mime       String
  sizeBytes  Int
  storageKey String
  storageUrl String
  createdAt  DateTime
  createdBy  String
}
```

There is no extensible "custom fields" mechanism today. Whatever
questions an author drops into an attachment-bound repeat group
either (a) get silently ignored by the runtime when it writes
attachment rows, or (b) end up on the parent feature row instead
of the attachment row. Both are wrong; both contradict the UI
affordance authors are seeing.

This doc proposes how to actually make per-attachment fields work,
so #158 ("split attachment-table columns into Standard vs
Per-attachment fields" on the data_layer detail page) has something
real to display.

## Use cases that motivate it

The pattern only matters when each attachment carries metadata
that's distinct from the parent feature:

- **Inspection photos**: feature = utility pole; per-photo:
  caption, photographer, capture timestamp, GPS at moment of
  capture (often differs from feature centroid), shot direction.
- **Site visits**: feature = parcel; per-photo: phase ("before",
  "during", "after"), elevation, weather notes.
- **Wildlife surveys**: feature = transect waypoint; per-photo:
  species ID, count, behavior code.
- **Damage assessment**: feature = building; per-photo: damage
  category (1–5), affected component, repair priority.

In each case the parent feature has its own attribute schema and
the photos collectively are not the feature; one feature has many
photos and each photo has its own metadata.

## Storage options

### Option A: JSONB column on `feature_attachment`

Add `customFields Json @map("custom_fields")` to the existing model.
The data_layer schema declares `attachmentCustomFields: FeatureField[]`
(typed names, types, constraints) so consumers know what's in the
JSON.

- Pros: zero new tables; one migration adds one column. Fits the
  existing per-attachment row 1:1. Reads come along for free with
  the existing `list()` query.
- Cons: no indexes on individual fields without GIN. Validation has
  to live in app code (Prisma can't enforce a JSONB schema). Can't
  easily query "all attachments where capture_phase = 'before'"
  without running Postgres JSONB operators per query.

### Option B: Side table `feature_attachment_field`

```
model FeatureAttachmentField {
  attachmentId String
  fieldName    String
  valueText    String?
  valueNum     Float?
  valueDate    DateTime?
  valueBool    Boolean?
  @@id([attachmentId, fieldName])
  attachment FeatureAttachment @relation(...)
}
```

EAV-style: one row per (attachment, field). Schema-less storage at
the DB layer; the data_layer item declares which fields exist.

- Pros: indexable per-field via the side-table column. Easy to add /
  remove a field without altering anything except the data_layer
  item's declared list. Each value's actual type is preserved
  (won't lose distinction between "5" the string and 5 the number).
- Cons: classic EAV problems - querying for "attachments matching
  ALL these conditions" needs N joins. Reading one attachment
  with all its fields is one extra query (or one join). Lots of
  rows for a busy form (10 fields × 10000 attachments = 100k
  rows).

### Option C: Per-data_layer dedicated table

Generate a per-data_layer attachment-fields table the same way v3
generates per-layer feature tables (`fs_<itemIdNoDashes>_<layerKey>`).
Schema is `attachment_id UUID PK FK + columns matching the
declared per-attachment fields`. One row per attachment, one column
per field.

- Pros: relational columns; indexes work as you'd expect; queries
  are normal SQL. Mirrors how v3 handles per-layer feature tables,
  so the codebase already has the schema-evolution machinery
  (`v3-tables.service.ts`, `toV3TableName` etc.).
- Cons: another set of dynamically-named tables. Schema changes
  (add/rename/drop a per-attachment field) need the same
  migration discipline v3 already enforces - small but non-trivial.

### Recommendation: Option C

The form-schema and runtime already deal with a per-data_layer
table abstraction (v3 feature tables). Reusing that pattern means:

- Authors who change the per-attachment fields schema use the
  same flow as changing a feature schema (already known territory).
- Querying "give me an attachment plus its custom fields" is a
  plain JOIN, not an EAV unfold or JSONB operator.
- The data_layer detail page's #158 split ("Standard fields vs
  Per-attachment fields") falls out naturally - the dedicated
  attachment-fields table's columns are the per-attachment list,
  and the existing fs_* feature table's columns are the standard
  list. No client-side derivation; the schema already segments
  them.
- Existing v3 reconcile-on-save logic
  (`V3TablesService.reconcile`) extends to attachment-field
  tables with the same CREATE / ADD COLUMN / DROP COLUMN
  vocabulary.

The cost is a second dynamically-named table per data_layer, named
something like `fa_<itemIdNoDashes>` (`fa` for feature-attachment
to distinguish from `fs` for feature-store).

## Schema impact (proposed)

`packages/shared-types/src/data-layer.ts`:

```ts
export interface DataLayerSublayer {
  ...
  attachmentsEnabled: boolean;
  // NEW
  attachmentFields?: FeatureField[];
}
```

`apps/portal-api/prisma/schema.prisma`: add nothing - the
attachment-fields table is dynamic, like fs_*.

`apps/portal-api/src/features-v3/v3-tables.service.ts`: extend
reconcile() to also handle the attachment-fields table for any
layer with `attachmentsEnabled === true && attachmentFields.length > 0`.

`apps/portal-api/src/features-v3/v3-attachments.service.ts`:

- Extend `register()` to accept `customFields: Record<string, unknown>`
  and write a row to the attachment-fields table in the same
  transaction.
- Extend `list()` to LEFT JOIN the attachment-fields table and
  return the merged shape.

`apps/portal-web` form runtime: when a question lives inside an
attachment-bound repeat group, the runtime needs to attribute its
value to the attachment row, not the parent feature row. Today the
runtime probably just lumps everything into the feature
submission; this is the load-bearing change.

## Migration story for existing forms

Forms shipped before this work that have questions inside
attachment groups currently store their answers nowhere. So:

- New forms get the right shape automatically.
- Existing in-the-wild "broken" forms keep silently dropping the
  data until the data_layer's `attachmentFields` is declared. The
  form designer should detect attachment-group questions and offer
  to wire them to per-attachment fields with a one-click "promote"
  action. The promote action edits the bound data_layer's
  `attachmentFields` to declare the matching FeatureFields, then
  re-saves.

## #158 scope (what unblocks once this lands)

Once Option C ships:

1. The data_layer detail page's schema view splits naturally:
   "Standard fields" = `sublayer.fields[]`, "Per-attachment fields"
   = `sublayer.attachmentFields[]`. Two tables, two captions, no
   client-side derivation.
2. The Replace data flow needs to know whether incoming columns
   align with feature or attachment scope; today's flow only knows
   features. A radio "incoming columns are: feature attributes /
   per-attachment metadata" handles that.
3. Form authors get an honest UI: dropping a question into an
   attachment group really does persist a per-attachment value.

## Phasing

- **Phase 1 - schema**: Add `attachmentFields` to the
  shared-types, extend V3TablesService.reconcile to provision the
  `fa_*` table, no UI yet. Sub-shippable; the table sits empty
  until something writes to it.
- **Phase 2 - runtime**: Form runtime persists attachment-scoped
  answers into the new table. Form designer keeps working as-is
  (the affordance from #157 already implies this scope).
- **Phase 3 - designer surface**: Data_layer detail page splits
  Standard vs Per-attachment columns. The "promote
  attachment-group questions" one-click flow lands here.
- **Phase 4 - query / export**: The export envelope and the
  attribute-table viewer learn to show per-attachment metadata
  alongside the file column.

Phases 1–3 are the minimum to make #157's UI honest. Phase 4 is
follow-on polish.

## Open questions

1. Should an attachment-field name collide with a feature-field
   name? Easiest: yes (different scopes, different tables, no
   collision). UI-easy: warn on collision but allow.
2. Do we need editing-policy (`all-rows` vs `own-rows-only`)
   parity for attachment fields? Probably yes - same semantics,
   same UI control.
3. Geometry as a per-attachment field (GPS-at-capture)? The
   parent feature owns the canonical geometry; per-attachment GPS
   is a separate `geometry(Point, 4326)` column on `fa_*`. PostGIS
   handles this cleanly.

## Status

Pre-implementation. No tickets cut against this doc yet. Awaits a
read by Matt to confirm Option C is the right pick before any
schema work begins.
