# Field app (form + form_submission_collection items)

The field app combines the Survey123-style form experience with the
Field Maps-style map-centric capture experience in one web app that
also runs as a PWA for offline use on phones and tablets.

## Two item types

- **form**: the definition of a data collection form. References a
  target data_layer (where submissions land) and a form schema
  (fields, validation, conditional visibility). The form-schema
  package holds the runtime-parseable descriptor.
- **form_submission_collection**: a queryable view of submissions
  against a given form. Not strictly needed as a separate item: a
  data_layer already is this: but giving it a dedicated item
  type makes discoverability better (you can share submissions
  without sharing the form).

## Offline model

All field data lives in a local store (IndexedDB) until the device
reaches the network, then syncs up to the feature service via a
queue of mutations. Conflict policy: last-write-wins for attribute
edits, additive for new features. No silent data loss; anything that
fails to sync stays visible in an "outbox" on the device.

Sync protocol candidates:

- Plain REST delta endpoints on feature services (simplest, works
  today).
- CRDT-based merge for attribute fields (Automerge): future, for
  true concurrent editing.

## Map + form flow

A submission can be initiated from:

- A list of forms.
- A map pin (long-press on a data_layer layer â†’ "Add form" if a
  form is bound to this layer).
- A scheduled task assignment (later: work orders).

Both the map and the form are fullscreen-capable on small screens; the
two are connected via a bottom-sheet pattern on mobile and a
side-by-side split on tablets / desktop.

## Not yet decided

- Native mobile apps. The PWA is the v1 because it ships everywhere
  without app-store friction. When we want native, MapLibre Native +
  React Native is the most aligned path.
- Work orders / assignments. Tracked in the tool-builder pillar.

## Status

Not implemented. Form schema scaffolding exists in
`packages/form-schema`. See `coming-soon.tsx` for the placeholder.
