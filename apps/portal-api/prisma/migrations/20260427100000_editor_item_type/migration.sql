-- Add 'editor' to the ItemType enum.
-- Editor items are online tool-driven workspaces for adding, editing,
-- and deleting features in one or more data_layer items. Pairs with
-- the upcoming data_collection item type to replace the Esri-style
-- "editing is everywhere and nowhere" sprawl with two concise items.
-- See docs/editing-and-collection.md for the design rationale.
ALTER TYPE "ItemType" ADD VALUE IF NOT EXISTS 'editor';
