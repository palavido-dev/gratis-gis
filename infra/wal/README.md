# WAL drill (not a backup)

**For continuous backups and point-in-time restore, use the pgBackRest
overlay instead:** `infra/docker-compose.pitr.yml`, set up with
`infra/pitr-setup.sh`. Design: `docs/cloud/backup-design.md`. Restore
steps: `docs/cloud/restore-runbook.md`.

This folder is removed once part B of `docs/cloud/pitr-test-plan.md`
has passed on a staging server (owner decision, 2026-11-23).

What is left in this directory is a small self-contained proof of how
PostgreSQL recovery to a time works, with a local folder as the WAL
archive and no backup tool. It is kept as a teaching aid and a quick
check that the image can replay WAL. It does not protect any data.

`pitr-drill.sh` only runs as project `gg-wal-drill`. It starts
PostgreSQL 17 with a WAL archive on a directory the script creates,
takes a base backup, writes two rows, and starts a second server from
that backup with `recovery_target_time` between the rows. The
recovered database contains the earlier row only. The drill password
in `compose.wal.yml` is only for that throwaway project.
