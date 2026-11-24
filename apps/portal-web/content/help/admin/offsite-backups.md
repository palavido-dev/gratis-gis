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

## The passphrase: read this first

Every copy is encrypted with a passphrase you choose. **If you lose the
passphrase, the off-site copies cannot be opened, by you or by anyone
else.** There is no reset and no recovery key.

- Store it in a password manager, or on paper in a safe place, before
  you save it. The page asks you to confirm that you have.
- The portal keeps a copy so scheduled backups can run. That copy is
  encrypted in the portal database with `CREDENTIAL_ENCRYPTION_KEY`.
  It is never written to the bucket and never shown again.
- If the server is lost, the copy in its database is lost with it. The
  copy you stored is the only one left.
- Changing the passphrase only affects new copies. Older copies still
  need the old passphrase, so keep it until they have aged out.

You can also set the passphrase, and every other setting, with
environment variables in `infra/.env.prod` (see
[Settings by environment](#settings-by-environment)). A value saved on
the page wins over the environment.

## What happens on each backup

1. The local backup runs as before and writes its `.tar.gz` archive.
2. The archive is encrypted on the server and streamed to the bucket in
   parts. Nothing extra is written to the server's disk.
3. Each part is checked by the provider against its checksum. After the
   upload, the size of the stored file is read back and compared.
4. A small `.json` file is written next to the copy. It holds the size
   and SHA-256 of the encrypted file and no secrets. A copy without it
   is treated as unfinished.
5. Copies older than **Days to keep off-site copies** are deleted. The
   newest good copy is always kept, however old it is.

The backup history shows the result of each copy under its status. A
failed copy has an **Upload again** button. A failed copy never changes
the local backup: it stays on the server as usual.

A notice goes to the operator admins when a copy fails, and when no
copy has succeeded for the number of days you set (3 by default).

### Large object stores

Object storage over the **mirror threshold** (50 GB by default) is not
re-uploaded inside the archive every night. Instead the database dump
is uploaded on its own, and files are copied one by one, only when they
are new or changed since the last copy. Files deleted on the portal
stay in the bucket until no copy inside the retention window refers to
them. The backup history says which mode ran.

A very large database (an `observation` table of tens of gigabytes) is
slow to dump every night. Large installs may prefer continuous database
archiving once it is available.

## What is in the bucket

Everything is under the folder you set (`gratisgis/` by default):

| Path | What it is |
| --- | --- |
| `archives/backup-<time>-<id>.tar.gz.enc` | The whole backup archive, encrypted |
| `archives/backup-<time>-<id>.tar.gz.enc.json` | Size and SHA-256 of the file above |
| `mirror/runs/<time>-<id>/` | Database dump, file index and manifest of one mirrored run, encrypted |
| `mirror/objects/<hash>.enc` | One stored file, encrypted |

File names inside `mirror/objects/` are hashes, so the bucket does not
show the names of your uploads.

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
itself. The page reminds you when no test has passed in 30 days.

The test reads the local archive. To check an off-site copy end to
end, restore it on a spare server with the steps below.

## Restore on a new server

Use this when the original server is gone. You need the passphrase,
the bucket settings, and, for stored credentials to keep working, the
original `CREDENTIAL_ENCRYPTION_KEY`.

1. Install GratisGIS on the new server with the installer, at the same
   release as the backup or a newer one.
2. Add the `BACKUP_OFFSITE_*` settings for the bucket to
   `infra/.env.prod`. Put back the original `CREDENTIAL_ENCRYPTION_KEY`
   if you have it.
3. Put the passphrase in a file that only root can read, with no other
   text in it.
4. See what is in the bucket:

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod \
     --passphrase-file /root/offsite.pass --list
   ```

5. Restore the newest copy (or name one with `--archive`):

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod \
     --passphrase-file /root/offsite.pass --confirm-project gratis-gis-prod
   ```

The script downloads the copy into the backups volume, checks it,
decrypts it, stops the portal, replaces the portal database and puts
the stored files back, runs the database migrations, starts the portal,
and prints the number of organizations, users, items and stored files
next to the numbers recorded in the backup.

The download and the unpacked files need free disk of about twice the
archive size. Identity (Keycloak users and passwords) is not in a
portal backup, as the [Backups](/help/admin/backups) page explains.

### Without the portal

The encrypted files use the same format as the host recovery bundles,
so the recovery tool can open one by hand with only Node.js:

```bash
node infra/recovery/seal.mjs dec /root/offsite.pass \
  backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc backup.tar.gz
```

The format is described in `docs/operations/offsite-backup-format.md`.

## Settings by environment

| Variable | Meaning |
| --- | --- |
| `BACKUP_OFFSITE_ENABLED` | `true` to copy each backup off-site |
| `BACKUP_OFFSITE_ENDPOINT` | The provider's S3 address |
| `BACKUP_OFFSITE_REGION` | Region name (`us-east-1` if unset) |
| `BACKUP_OFFSITE_BUCKET` | Bucket name |
| `BACKUP_OFFSITE_PREFIX` | Folder in the bucket (`gratisgis/` if unset) |
| `BACKUP_OFFSITE_PATH_STYLE` | `false` for AWS S3 |
| `BACKUP_OFFSITE_ACCESS_KEY_ID` | Access key id |
| `BACKUP_OFFSITE_SECRET_ACCESS_KEY` or `..._FILE` | Secret access key, or a file holding it |
| `BACKUP_OFFSITE_PASSPHRASE` or `..._FILE` | Encryption passphrase, or a file holding it |
| `BACKUP_OFFSITE_RETENTION_DAYS` | Days to keep copies (30) |
| `BACKUP_OFFSITE_ALERT_DAYS` | Days without a good copy before a notice (3) |
| `BACKUP_OFFSITE_MIRROR_THRESHOLD_GB` | Copy files one by one above this (50) |

The endpoint must use `https`. `BACKUP_OFFSITE_ALLOW_HTTP=true` allows
plain `http`, for a test store on a private network only.
