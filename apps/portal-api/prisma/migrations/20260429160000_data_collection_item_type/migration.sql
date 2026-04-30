-- Add the `data-collection` variant to ItemType. A data_collection
-- item is a Field Maps-style "field deployment" wrapper around a
-- map: it points at a map item, optionally binds custom forms to
-- specific editable layers (defaulting to schema-derived forms when
-- no binding is set, matching Field Maps' popup-as-form convention),
-- and carries offline-collection configuration. The field-mode
-- runtime opens a data_collection on a phone-friendly canvas and
-- handles tap-to-add / tap-to-edit feature workflows.
-- Enum alters run standalone per Postgres rules.
ALTER TYPE "ItemType" ADD VALUE 'data-collection';
