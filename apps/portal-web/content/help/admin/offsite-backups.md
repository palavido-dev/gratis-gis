---
id: admin-offsite-backups
title: Off-site backups
seoTitle: "Encrypted off-site backups for a self-hosted GratisGIS portal"
summary: Send an encrypted copy of every backup to S3-compatible storage at another provider, and bring a portal back from it on a new server.
category: admin
order: 31
complexity: advanced
tags:
  - admin
  - backup
  - restore
  - offsite
  - s3
  - encryption
related:
  - admin-backups
---
A backup that sits on the same server as the portal is lost with that
server. **Off-site copies** send each backup to a bucket at another
storage provider, encrypted before it leaves the server.

Set it up on **Admin → Backup → Off-site copies**. Only admins of the
operator organization (the first organization on the portal, unless
`GRATIS_OPERATOR_ORG_ID` says otherwise) see this section.

## Your key: read this first

Copies are encrypted to **your public key**. Only the matching
**private key file**, opened with **its passphrase**, can read them.
The portal never has the private key or the passphrase: it can make
copies, but it cannot open them, and neither can anyone who takes over
the server.

**If you lose the key file, or forget its passphrase, every off-site
copy is unreadable, by you and by anyone else.** There is no reset and
no recovery key. Not the storage provider, not GratisGIS, nobody.

1. On your own computer (not the portal server), with Node.js 20 or
   newer, make the key pair with the key tool from this release,
   `infra/recovery/offsite-key.mjs`. It is one file; copy it anywhere.

   ```bash
   node offsite-key.mjs generate my-portal.ggkey
   ```

   It asks for a passphrase twice (at least 16 characters), writes the
   key file, and prints the **public key** (`ggpub1:...`) and its
   **fingerprint**.
2. Store the key file in at least two safe places away from the portal
   server, and the passphrase in a password manager.
3. Paste only the public key on the page, tick the box that says you
   have stored the key file and passphrase, and save. The page shows
   the key's fingerprint from then on, and every backup run records it.
4. Use **Check my key** now and then. On your computer run
   `node offsite-key.mjs public my-portal.ggkey`: it asks for the
   passphrase, so it also proves you can still open the key file. Paste
   the public key or fingerprint it prints; the page says whether it
   matches the key the portal encrypts to.

The passphrase is used as typed, with one trailing line break ignored
and the text normalised to Unicode NFC, so the same words open the file
on Windows, macOS and Linux.

**Replacing the key** affects only new copies. Copies made before still
open only with the old key file and its passphrase: keep both until
those copies have aged out of the retention window. The portal never
re-reads or re-encrypts old copies. In mirror mode, a new key means every
file is uploaded again, once.

Never paste a private key or a passphrase into the portal. It refuses
them.

You can also set the public key, and every other setting, with
environment variables in `infra/.env.prod` (see
[Settings by environment](#settings-by-environment)). A value saved on
the page wins over the environment.

## What happens on each backup

1. The local backup runs as before and writes its `.tar.gz` archive.
2. The archive is encrypted on the server to your public key and
   streamed to the bucket in parts. Nothing extra is written to the
   server's disk. A backup started with **Run now** finishes on the page
   straight away; its off-site copy carries on in the background.
3. Each part is checked by the provider against its checksum. After the
   upload, the size of the stored file is read back and compared.
4. A small `.json` file is written next to the copy. It holds the size,
   the SHA-256 of the encrypted file and the key fingerprint, and no
   secrets. A copy without it is treated as unfinished.
5. Copies older than **Days to keep off-site copies** are deleted. The
   newest good copy is always kept, however old it is.

The backup history shows the result of each copy under its status, with
the fingerprint of the key it was encrypted to. A failed copy has an
**Upload again** button. A failed copy never changes the local backup:
it stays on the server as usual. **Upload again** is refused for a
backup older than the retention window (it would be deleted again at
once), and in mirror mode for anything but the newest backup, because a
mirrored copy always holds the files as they are now.

One off-site upload runs at a time for the whole portal. A backup that
finishes while another copy is uploading is not copied off-site; use
**Upload again** on it, or let the next backup run.

A notice goes to the operator admins when a copy fails, and when no
copy has succeeded for the number of days you set (3 by default).

### Large object stores

Object storage over the **mirror threshold** (50 GB by default) is not
re-uploaded inside the archive every night. Instead the database dump
is uploaded on its own, and files are copied one by one, only when they
are new or changed since the last copy. Files deleted on the portal
stay in the bucket until no copy inside the retention window refers to
them. The backup history says which mode ran.

The portal cannot read its own copies, so it keeps a record of what it
uploaded in its database. If that record is lost, the next run simply
uploads every file again. After a restore on a new server, files the
new server's record does not know are left in the bucket rather than
deleted; a lifecycle rule at the provider can expire them.

Mirror mode needs `CREDENTIAL_ENCRYPTION_KEY` (set by the installer):
it keeps the key that names the files in the bucket with it.

A very large database (an `observation` table of tens of gigabytes) is
slow to dump every night. Large installs may prefer continuous database
archiving once it is available.

## What is in the bucket

Everything is under the folder you set. By default each portal gets its
own folder, `gratisgis-` and the first 8 characters of its install id.
**Use one folder per portal.** The portal writes a small
`gratisgis-install.json` marker in its folder and stops, without
deleting anything, if the folder belongs to another portal. Note the
folder down: a restore looks for it.

| Path | What it is |
| --- | --- |
| `gratisgis-install.json` | Which portal owns this folder |
| `archives/backup-<time>-<id>.tar.gz.enc` | The whole backup archive, encrypted |
| `archives/backup-<time>-<id>.tar.gz.enc.json` | Size and SHA-256 of the file above |
| `mirror/runs/<time>-<id>/` | Database dump, file index and manifest of one mirrored run, encrypted |
| `mirror/objects/<name>.enc` | One stored file, encrypted |

File names inside `mirror/objects/` are made with a key only the portal
has, so the bucket shows neither the names nor anything about the
content of your uploads.

## Protect the copies from a compromised server

The portal needs permission to delete in the bucket so it can apply
retention. Someone who takes over the server has that permission too.
Turn on **bucket versioning** or **object lock** at the provider, with
a retention period at least as long as yours, so deleted copies can
still be recovered for a while. Add a lifecycle rule that removes old
versions after that period, or storage keeps growing.

Also add a rule that cleans up **incomplete multipart uploads** after a
few days. An upload stopped by a restart leaves parts behind until such
a rule removes them.

## Provider setup

Make a new bucket only for these backups, and a key that can only reach
that bucket. Then fill in the page and click **Test connection**: it
writes, lists and deletes one small file.

Prices below are rough, for planning only. Check the provider's own
price list.

### Backblaze B2

- **Endpoint:** `https://s3.<region>.backblazeb2.com`, for example
  `https://s3.eu-central-003.backblazeb2.com`. The bucket page shows it.
- **Region:** the part after `s3.`, for example `eu-central-003`.
- **Keys:** App Keys → Add a New Application Key, limited to the
  bucket, with read and write access. The **keyID** is the access key
  id and the **applicationKey** is the secret.
- Path-style addresses work.
- B2 keeps every version of a file by default. Set the bucket's
  lifecycle to keep prior versions for your retention period, or
  deleted copies keep using space. B2 also offers object lock.
- Cost: roughly USD 6 per TB per month, with free download up to three
  times the stored amount.

### Cloudflare R2

- **Endpoint:** `https://<account-id>.r2.cloudflarestorage.com`, shown
  on the bucket's settings page.
- **Region:** `auto`.
- **Keys:** R2 → Manage API tokens → Create API token, with **Object
  Read & Write** on this bucket only. Use the S3 access key id and
  secret it shows once.
- Path-style addresses work.
- R2 bucket locks can stop deletion for a set time.
- Cost: roughly USD 15 per TB per month, with no charge for downloads.

### AWS S3

- **Endpoint:** `https://s3.<region>.amazonaws.com`, for example
  `https://s3.eu-central-1.amazonaws.com`.
- **Region:** the bucket's region, for example `eu-central-1`.
- **Keys:** an IAM user with a policy that allows `s3:ListBucket` on
  the bucket and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
  `s3:AbortMultipartUpload` on `arn:aws:s3:::<bucket>/*`.
- Turn **off** path-style addresses for AWS.
- Versioning and object lock are bucket settings.
- Cost: roughly USD 23 per TB per month in S3 Standard, less in the
  infrequent-access classes, plus charges for downloads.

### Hetzner Object Storage

- **Endpoint:** `https://<location>.your-objectstorage.com`, for
  example `https://fsn1.your-objectstorage.com`.
- **Region:** the location, for example `fsn1`.
- **Keys:** Cloud Console → your project → Security → S3 credentials.
- Versioning can be turned on per bucket. Check the Hetzner
  documentation for object lock in your location.
- Cost: roughly EUR 5 per month, which includes about 1 TB of storage
  and 1 TB of downloads, then a price per extra TB.

## Test a backup

**Test latest backup** on the Backup page restores the newest backup's
database into a scratch database next to the portal's, counts
organizations, users, items and applied migrations, and deletes the
scratch database. The portal is not changed. A cut-short or damaged
archive fails the test.

While it runs, the database needs free space for one more copy of
itself. When the portal can measure free space where the database keeps
its files (with `BACKUP_PGDUMP_DOCKER_CONTAINER`, or `BACKUP_PG_DATA_DIR`
on a host install), it refuses a test that would not fit. Otherwise the
page shows the database size and asks you to confirm before it starts.
The page reminds you when no test has passed in 30 days.

The test reads the local archive. To check an off-site copy end to
end, restore it on a spare server with the steps below.

## Restore on a new server

Use this when the original server is gone. You need the key file, its
passphrase, the bucket settings, and, for stored credentials to keep
working, the original `CREDENTIAL_ENCRYPTION_KEY`.

1. Install GratisGIS on the new server with the installer, at the same
   release as the backup or a newer one.
2. Add the `BACKUP_OFFSITE_*` bucket settings to `infra/.env.prod`. Put
   back the original `CREDENTIAL_ENCRYPTION_KEY` if you have it. Set
   `BACKUP_OFFSITE_PREFIX` to the portal's folder; when it is unset and
   the bucket holds one portal folder, the script finds it.
3. Copy the key file to the server, and put its passphrase in a file
   that only root can read (`chmod 600`).
4. See what is in the bucket:

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod --list
   ```

5. Restore the newest copy (or name one with `--archive`, or a mirrored
   run with `--mirror-run`, as `--list` prints them):

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod \
     --key-file /root/my-portal.ggkey --passphrase-file /root/my-portal.pass
   ```

The script opens the key file first and stops if it does not open. It
then shows the project, the database and how many organizations, users
and items it holds, and asks you to type the database name. It refuses
a database that is in use (it has users) unless you add
`--replace-existing`. In a script, `--confirm-database NAME` replaces
the typing.

It then downloads the copy into the backups volume, checks and decrypts
it, stops the portal, **saves the current database with `pg_dump`** in
the backups volume, replaces the portal database, runs the database
migrations, empties the new server's record of mirrored files, puts the
stored files back, starts the portal, and prints the number of
organizations, users, items and stored files next to the numbers
recorded in the backup.

Off-site copies are **turned off** on the restored server, so a test
restore can never clean up the real portal's copies. Turn them on again
on Admin, Backup once the new server is the one in use.

The download and the unpacked files need free disk of about twice the
archive size. Identity (Keycloak users and passwords) is not in a
portal backup, as the [Backups](/help/admin/backups) page explains.

### Without the portal

The key tool opens any copy with only Node.js:

```bash
node offsite-key.mjs decrypt my-portal.ggkey \
  backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc backup.tar.gz
```

It asks for the passphrase, or reads it from `--passphrase-file FILE`.
A passphrase file may end with one line break (LF or CRLF); that one is
ignored. The output file appears only after the whole copy verified. The
format is described in `docs/operations/offsite-backup-format.md`.

## Settings by environment

| Variable | Meaning |
| --- | --- |
| `BACKUP_OFFSITE_ENABLED` | `true` to copy each backup off-site |
| `BACKUP_OFFSITE_ENDPOINT` | The provider's S3 address |
| `BACKUP_OFFSITE_REGION` | Region name (`us-east-1` if unset) |
| `BACKUP_OFFSITE_BUCKET` | Bucket name |
| `BACKUP_OFFSITE_PREFIX` | Folder in the bucket (`gratisgis-<install id>/` if unset) |
| `BACKUP_OFFSITE_PATH_STYLE` | `false` for AWS S3 |
| `BACKUP_OFFSITE_ACCESS_KEY_ID` | Access key id |
| `BACKUP_OFFSITE_SECRET_ACCESS_KEY` or `..._FILE` | Secret access key, or a file holding it |
| `BACKUP_OFFSITE_PUBLIC_KEY` | Your public key (`ggpub1:...`) |
| `BACKUP_OFFSITE_RETENTION_DAYS` | Days to keep copies (30) |
| `BACKUP_OFFSITE_ALERT_DAYS` | Days without a good copy before a notice (3) |
| `BACKUP_OFFSITE_MIRROR_THRESHOLD_GB` | Copy files one by one above this (50) |

Docker Compose reads `$` in `infra/.env.prod` as the start of a
variable. If the secret access key contains a `$`, put it in a file
and use `BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE` instead, or save it on
the page.

Values from the environment are checked like values typed on the page.
A refused value is shown on the page and off-site copies do not run
until it is fixed.

The endpoint must use `https`. `BACKUP_OFFSITE_ALLOW_HTTP=true` in the
server environment allows plain `http`, for a test store on a private
network only; the page cannot turn it on, it applies to endpoints from
either source, and every run logs a warning. The endpoint cannot be the
server itself, a link-local address or a cloud metadata address, also
after DNS, unless `BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT=true`.

`infra/install.sh --check` says whether off-site backups are set up on
an existing install.
