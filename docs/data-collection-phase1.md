# Data Collection Phase 1 - Implementation Notes

(#131) Implementation companion to `docs/editing-and-collection.md`,
captured at the end of this branch.

## What landed in this PR

End-to-end form authoring + capture, online + offline, with shared
designer + runtime that both Survey-style and Field-style entry
points will reuse:

- `@gratis-gis/form-schema` expanded into the full shared kernel:
  21 question types, conditional visibility, calculations, validation,
  layer-binding metadata, JSON-only expression DSL with a fixed
  whitelist of builtins.
- Form designer (`apps/portal-web/src/app/items/[id]/form/designer.tsx`):
  three-panel UX (palette / canvas / properties), HTML5 native drag-
  drop (no extra deps), tap-to-add for touch, live Preview tab that
  swaps the canvas for the real runtime against the in-memory schema.
- Form runtime (`apps/portal-web/src/components/form-runtime.tsx`):
  mobile-first single-column layout, native input types so phone
  keyboards do the right thing, sticky bottom bar with Next / Submit,
  per-page progress, paged surveys when the schema includes `page`
  questions, repeating groups, GPS capture for `geopoint`, photo
  capture via `<input type=file capture=environment>`.
- Public respond page (`/forms/[id]/respond`): server-renders the
  schema for fast first paint, hands off to a client wrapper that
  manages online/offline + the IndexedDB outbox.
- Offline outbox (`apps/portal-web/src/lib/form-offline.ts`): zero-
  dependency wrapper over native IndexedDB. Submissions queue with
  a client-generated UUID, status flips queued -> sending -> sent /
  failed, the wrapper auto-drains when `online` event fires.
- Backend submissions store (`apps/portal-api/src/forms/`): new
  `form_submission` table, `FormSubmission` Prisma model, controller
  at `/api/forms/:id/submissions`. Idempotent upsert on
  `(formId, clientId)` so a re-drained queue is a no-op. Captured
  `schemaVersion` is preserved.

## How the dual entry points share this

The schema, the runtime, and the designer are agnostic to where the
form was reached from. Two thin entry points feed them:

- **Survey-first** (Survey123-style): `/forms/<id>/respond`. The user
  hits the URL (link in email, QR code, etc.), `RespondClient` opens
  with no pre-filled values. Geometry capture, if any, comes from a
  `geopoint` question in the schema.
- **Field-first** (Field Maps-style, Phase 1b): a `data_collection`
  item type in `mode: "map"`. The user opens the runtime, sees a map
  with the configured editable layers, taps "Add" against a layer.
  The runtime opens the form bound to that layer, with the captured
  geometry pre-filled into the `geopoint` question. This shares the
  exact runtime + designer; the only differentiator is the entry
  point and the `bindTo` metadata that maps each question to a
  column on the target data_layer. The designer's palette filters by
  `compatibleQuestionTypes(columnType)` when bound to a layer.

The shared schema also makes "the same form, two ways" trivial: a
`form` item in `Field` mode is just a `form` item that some
`data_collection` references via `bindTo`. There's never an XLSForm-
vs-Field-Maps split.

## Open follow-ups for Phase 1b

- `data_collection` item type: scaffolding (type enum, create wizard
  with mode picker, draft state, targets editor). Wires a form to a
  submission collection (Survey mode) or a map + per-layer forms
  (Field mode).
- Field runtime: map canvas + per-layer feature templates. The Editor
  item already has all the moving parts (slices 3b-1 through 3b-5);
  Field mode is mostly the Editor canvas + the FormRuntime opening
  on Add instead of the existing AttributeForm.
- Service worker pre-cache of the form runtime bundle + form schema
  + target layer schemas, so a mobile user can install the PWA, go
  out of range, capture, and sync on return. The IndexedDB outbox
  is already in place; the missing piece is the SW pre-cache and a
  manifest that lists the form-runtime route as a startable scope.
- Drag-drop on touch devices. HTML5 native DnD is desktop-only on
  iOS Safari; tap-to-add works there but reorder-by-grip doesn't.
  Phase 1b adds a touch fallback (long-press + drag, or up/down
  arrows on each row).
- Conditional logic builder Phase 2: today the designer's logic
  panel only writes a single `eq` between a ref and a literal. The
  Expression DSL supports the fuller shape (and / or / not / between
  / arithmetic / builtins); the UI catches up next.
- Submission detail page on a form item: list captured submissions
  with field-level inspection. The `/forms/:id/submissions` GET
  already exists; it just needs a UI.

## Schema-version contract

Submissions carry `schemaVersion`. The current version is
`CURRENT_FORM_SCHEMA_VERSION = 1`. When we bump, every renderer in
the field that wrote a submission against v1 keeps working: the
server stores the response as-is, and downstream consumers can
inspect both the captured version and the current form schema to
decide how to project. This matches the schema-evolution policy in
`editing-and-collection.md` and is the explicit anti-Survey123
position (no orphaned data, no broken in-flight queues on form
edits).

## Mobile + offline in numbers

- **First paint**: the respond page is a server component, so the
  user gets a working form (no spinner) before any JS hydrates.
  Once hydrated, the runtime works fully offline.
- **Outbox depth**: bounded by IndexedDB quota (~hundreds of MB on
  modern phones); a single submission with a couple of photos is
  ~200 KB-2 MB depending on image size. A field crew should be able
  to queue dozens of submissions in a sub-50-MB outbox.
- **Submission idempotency**: `clientId` UUID generated at capture
  time; backend upserts on `(formId, clientId)`. A submission
  drained twice is a no-op; the client only purges the outbox row
  when the server returns 2xx for the matching `clientId`.

## Where to test

1. Create a form item via the Add menu -> Forms -> Form.
2. Open the form item detail page; you'll get the designer.
3. Drag question types from the left palette into the canvas; click
   Save.
4. Open the link at the bottom (`/forms/<id>/respond`) -- ideally
   from your phone on the same Wi-Fi as the dev server.
5. Fill in the form. Toggle airplane mode mid-response: the submit
   queues to IndexedDB, the Outbox card appears, and re-enabling
   network drains it.
