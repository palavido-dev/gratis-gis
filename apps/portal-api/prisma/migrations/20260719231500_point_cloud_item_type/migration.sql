-- #179 (3D as layers, phase A): point_cloud item type. Wraps one
-- COPC file in MinIO, range-served through the API with the item's
-- read ACL, streamed by viewport in the viewer. data_json shape is
-- PointCloudData from shared-types.

ALTER TYPE "ItemType" ADD VALUE 'point-cloud';
