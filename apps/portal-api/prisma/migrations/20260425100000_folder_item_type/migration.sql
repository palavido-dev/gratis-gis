-- Add 'folder' to the ItemType enum.
-- Folders are first-class items used to organize other items.
-- See docs/folders.md for the design rationale.
ALTER TYPE "ItemType" ADD VALUE IF NOT EXISTS 'folder';