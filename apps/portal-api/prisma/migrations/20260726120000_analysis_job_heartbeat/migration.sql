-- Analysis job lifecycle hardening: worker liveness beat.
-- The pointcloud worker stamps heartbeat_at on claim, on every
-- progress write, and every ~10s during long silent tool runs; the
-- reclaim sweep in the analysis bridge marks running rows with a
-- stale beat as failed ('worker stopped responding'), because a
-- killed worker cannot flip its own rows and the UI would otherwise
-- show a spinner forever. timestamptz (not the table's timestamp(3))
-- on purpose: the beat is compared against now() across containers,
-- so it must be zone-anchored.
ALTER TABLE "analysis_job" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6);
