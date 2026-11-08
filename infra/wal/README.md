# WAL point-in-time recovery

Opt-in. The dev, NAS, and VPS compose files do not set `archive_mode`.

`pitr-drill.sh` only runs as project `gg-wal-drill`. It starts
PostgreSQL 17 with a WAL archive on a directory the script creates,
takes a base backup, writes two rows, and starts a second server from
that backup with `recovery_target_time` between the rows. The
recovered database contains the earlier row only.

An operator who wants this on a real deployment has to turn on
`archive_mode` and `archive_command` themselves and keep the archive
on storage that is not the database disk. This directory does not do
that for them. The drill password in `compose.wal.yml` is only for
that throwaway project.
