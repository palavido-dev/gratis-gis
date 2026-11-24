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

**Replacing the key** is announced to every operator admin, and the
page shows when it was changed, by whom, and the fingerprint it
replaced. If you did not expect it, check the page at once: copies made
from then on open only with the new key's file.

A replaced key affects only new copies. Copies made before still
open only with the old key file and its passphrase: keep both until
those copies have aged out of the retention window. The portal never
re-reads or re-encrypts old copies.

Never paste a private key or a passphrase into the portal. It refuses
them.

## Signed copies: add the verify key to your key file

Your public key is not secret, so anyone who can write to the bucket
could add a copy that opens with your key file. To tell your portal's
copies from any others, the portal signs every copy with a **signing
key** that only it holds. It makes that key itself the first time
off-site copies are set up, and stores it encrypted with the server's
`CREDENTIAL_ENCRYPTION_KEY`; it is never shown or logged. It is never
uploaded on its own, but the database dump inside every copy holds it,
still encrypted with `CREDENTIAL_ENCRYPTION_KEY`, which is not in the
copy.

The page shows the matching **verify key** (`ggver1:...`) and its
fingerprint. Add it to your key file, on your own computer:

```bash
node offsite-key.mjs trust my-portal.ggkey my-portal-new.ggkey ggver1:...
```

It asks for the key file's passphrase and writes a **new** key file,
sealed with the same passphrase, that also holds the verify key; it
never replaces an existing file. Check that the new file opens
(`node offsite-key.mjs public my-portal-new.ggkey` lists its verify
keys), then keep it in place of the old one, in every place you keep
the key file. Then use **Check my verify key** on the page: paste the
newest verify key that `public` lists, or its fingerprint.

Do this after setting off-site copies up, and again whenever the page
shows a new signing key. Older verify keys stay in the key file, so
copies signed with them still check.

**What signing protects.** A restore checks each copy's signature
against the verify keys in your key file before it downloads, decrypts
or changes anything, and refuses a copy that was changed, renamed,
moved from another folder or portal, or made by someone else. This
protects you when the bucket keys leak. It does not help if the portal
server itself is taken over: whoever controls the server also controls
its signing key. It also does not stop someone with the bucket keys
from deleting copies, or from putting an older genuine copy back under
its own name; bucket versioning or object lock (below) and the date the
restore shows you cover those.

**A new signing key.** Use **Make a new signing key** only when you
think the old one was exposed. The operator admins get a notice and the
change goes into the audit log. Copies signed with the old key stay
valid. A server restored from an off-site copy makes its own new
signing key; add that one too.

If the stored signing key can no longer be opened (for example because
`CREDENTIAL_ENCRYPTION_KEY` changed), the portal makes a new one by
itself and the notice says so. The old verify key stays one of the
portal's earlier keys, so copies signed with it still count as good and
age out as usual. Only if the stored signing key opens but does not
match its verify key is that verify key no longer trusted: copies
signed with it are then set aside, kept and not deleted. A restore with
a key file that holds the old verify key still checks them.

Copies made before signing existed, and every copy while your key file
has no verify key yet, cannot be checked. The restore uses such a copy
only when you ask for it explicitly (see
[Restore on a new server](#restore-on-a-new-server)).

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
once).

When a backup is uploaded again, the portal first looks for an earlier
upload of it. If one is complete, signed by this portal for this
folder, and the stored size is the signed size, it is used as it is and
nothing is sent. Otherwise the copy goes up under a new name, with
`-r2`, `-r3` and so on before `.tar.gz`, so a file that a signed record
may describe is never replaced. Pieces of an earlier upload that did
not finish are removed only after the new copy and its `.json` file are
both in the bucket. An earlier copy that is complete but does not
check is left as it is; retention sets it aside.

One off-site upload runs at a time for the whole portal. A backup that
finishes while another copy is uploading is not copied off-site; use
**Upload again** on it, or let the next backup run.

An upload that stops getting answers from the provider is given up:
each request after 2 minutes of silence, and the whole upload after 2
hours plus the time to send it at 256 KiB/s (about 2 Mbit/s). It is
marked failed, a notice goes out, and the next upload can start.

A notice goes to the operator admins when a copy fails, and when no
copy has succeeded for the number of days you set (3 by default).

### Very large backups

A backup is copied off-site only when its upload time limit (above)
fits in the 24 hours between nightly backups, which is a backup of
about 19 GB. The off-site copy of a larger backup fails with a message
that says so, and the usual notice goes out; the local backup is not
affected. The page shows the size of the newest backup and its upload
time limit, so you can see a backup growing towards that size. Very
large installs whose backup cannot be uploaded each night are not
covered by this feature yet.

## What is in the bucket

Everything is under the folder you set. By default each portal gets its
own folder, `gratisgis-` and the first 8 characters of its install id.
**Use one folder per portal.** The folder cannot be empty: the whole
bucket is never one portal's folder. Folder names use letters `A-Z` and
`a-z`, digits `0-9`, `.`, `_` and `-`, with `/` between folders, such
as `backups/site-a/`. The page, the environment and the restore tool
all accept the same names. The portal writes a small
`gratisgis-install.json` marker in its folder and stops, without
deleting anything, if the folder belongs to another portal. Note the
folder down: a restore looks for it.

Only files named the way the portal names them count as copies. A copy
whose name is dated in the future, or more than an hour after the
provider recorded it, is kept but set aside: it is never treated as the
newest copy and never deleted by retention. The same happens to a copy
whose signature does not check with this portal's verify keys. The
operator admins get one notice per retention pass with how many copies
were set aside and why; the same copies are not announced twice. Each
pass reads at most 100 badly signed copies; older copies then wait for
a later pass, and nothing older is deleted in that pass.
Retention counts a signed copy as the newest good one; copies made
before signing existed count until the first signed copy is there, then
age out as usual.

Retention reads the record of every copy before it deletes anything.
If one cannot be read, it deletes nothing in that pass and the operator
admins get a notice (at most once a day).

| Path | What it is |
| --- | --- |
| `gratisgis-install.json` | Which portal owns this folder |
| `archives/backup-<time>-<id>.tar.gz.enc` | The whole backup archive, encrypted |
| `archives/backup-<time>-<id>.tar.gz.enc.json` | Size and SHA-256 of the file above, signed by the portal |
| `archives/backup-<time>-<id>-r<n>.tar.gz.enc` | The same backup, uploaded again under a new name, with its own `.json` file |

## Protect the copies

Signatures (above) let a restore tell your portal's copies from copies
someone else put in the bucket. They cannot stop copies from being
deleted, and they do not help once the portal server itself is taken
over. So:

- Use a bucket key made for this portal and this bucket only, and keep
  it nowhere else.
- Turn on **bucket versioning** or **object lock** at the provider,
  with a retention period at least as long as yours, so copies that
  were deleted or replaced can still be got back. The portal needs
  permission to delete so it can apply retention, and someone who takes
  over the server has that permission too. Add a lifecycle rule that
  removes old versions after that period, or storage keeps growing.
- When you restore after a break-in or other incident, pick a copy made
  **before** it. The restore script shows each copy's date, the key it
  was made for and the verify key that signed it, and asks before it
  changes anything.
- The restore runs the database dump as the database's owner, which in
  the default install has full rights. If you are not sure where a copy
  came from, restore it on a spare server first, or look through it
  (`pg_restore -l`) before restoring it on the real one.

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

One test runs at a time. The test reads the local archive. To check an
off-site copy end to end, restore it on a spare server with the steps
below.

## Restore on a new server

Use this when the original server is gone. You need the key file, its
passphrase, the bucket settings, and, for stored credentials to keep
working, the original `CREDENTIAL_ENCRYPTION_KEY`.

1. Install GratisGIS on the new server with the installer, at the same
   release as the backup or a newer one.
2. Add the `BACKUP_OFFSITE_*` bucket settings to `infra/.env.prod`. Put
   back the original `CREDENTIAL_ENCRYPTION_KEY` if you have it. Set
   `BACKUP_OFFSITE_PREFIX` to the portal's folder, or to a folder above
   it. When it is unset, the script looks through the bucket (four
   folders deep) for the portal folder. If it finds none, or more than
   one, it stops and lists the folders it looked in.
3. Copy the key file to the server, and put its passphrase in a file
   that only root can read (`chmod 600`).
4. See what is in the bucket:

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod --list
   ```

5. Restore the newest copy (or name one with `--archive`, as `--list`
   prints them):

   ```bash
   sudo infra/restore-from-offsite.sh --env-file infra/.env.prod \
     --key-file /root/my-portal.ggkey --passphrase-file /root/my-portal.pass
   ```

The script opens the key file first and stops if it does not open, and
lists the verify keys the key file holds. It checks the signature of
each copy against them and uses the newest copy that verifies and was
made by the portal the folder belongs to. It then
shows the copy it will use (its name, the date it was made, when the
provider received it, its size, the fingerprint of the key it was made
for and the verify key that signed it) and the project, the database and how many organizations,
users and items it holds, and asks you to type the database name.
Nothing is downloaded or changed before that. It stops if the copy was
made for another key. It refuses a database that is in use (it has
users) unless you add `--replace-existing`. In a script,
`--confirm-database NAME` replaces the typing, and then the copy must be
named with `--archive`.

When no copy verifies, the script offers the best one left, in this
order, and uses it only with that kind's own option, or when you type
its word in a terminal. Each option allows only its own kind:

| The copy | Option | Word | What is checked |
| --- | --- | --- | --- |
| Signed with a verify key in your key file, but for another portal install | `--allow-foreign-install` | `FOREIGN` | The signature, and the size and SHA-256 of the copy against the signed record. Not checked: that this folder's portal made it. |
| Names a verify key your key file does not hold | `--allow-untrusted-signer` | `UNTRUSTED` | Not who made it: the named verify key is only a claim. Size and SHA-256 only against the plain `.json` file in the bucket, which catches damage but not a deliberate change. |
| Not signed (made before signing existed) | `--allow-unsigned-copy` | `UNSIGNED` | Not who made it. Size and SHA-256 only against the plain `.json` file in the bucket, when it records them. |

The script shows which kind the chosen copy is and what was and was
not checked. A copy whose signature does not verify, or that was signed
for another name or folder, is never restored.

It then downloads the copy into the backups volume, checks its size and
SHA-256 against the signed record (for a copy that is not verified,
against its plain `.json` file), and only then decrypts it. It stops
the portal, **saves the current database with `pg_dump`** in the
backups volume and checks that the saved file reads back, replaces the
portal database, runs the database migrations, puts the stored files
back from the decrypted archive, starts the portal, and prints the
number of organizations, users, items and stored files next to the
numbers recorded in the backup.

Off-site copies are **turned off** on the restored server, and it gets a
new install id and a new signing key, so a test restore can never clean
up the real portal's copies, and the old server's signing key is not
reused. The backup's verify key is kept as one of the portal's earlier
keys only when the copy's signature was checked with it, so copies the
old server signed still count once this server takes the folder over.
Add the new verify key to your key file. Once the new server is the one
in use, turn off-site copies on again on Admin, Backup. The first copy stops because the folder still
belongs to the old install: open **Take over this folder**, type the
start of the old install id that the message shows, and the next copy
goes ahead. Nothing in the folder is deleted when you take it over.

A restore inside the portal (Admin, Backup, Restore) keeps the off-site
settings the portal has now, not the ones in the archive, so an older
backup never brings back an older key, signing key or bucket. A host
recovery bundle restored with `infra/recovery/restore.sh` is treated
like a restore on a new server: off-site copies are turned off, with a
new install id and no signing key from the bundle, until you turn them
on again on Admin, Backup.

The download and the unpacked files need free disk of about twice the
archive size. Identity (Keycloak users and passwords) is not in a
portal backup, as the [Backups](/help/admin/backups) page explains.

### Without the portal

The key tool opens any copy with only Node.js:

```bash
node offsite-key.mjs decrypt my-portal.ggkey \
  backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc backup.tar.gz
```

Add `--sidecar FILE` with the copy's `.json` file to check its
signature first: the tool then decrypts only a copy signed by a verify
key in your key file. It checks the size and SHA-256 while it decrypts,
into a temporary file next to the output, and the output file appears
only when they matched what was signed.
`node offsite-key.mjs verify my-portal.ggkey COPY.enc.json COPY.enc`
checks a copy without decrypting it.

It asks for the passphrase, or reads it from `--passphrase-file FILE`.
Save the passphrase in the file without a trailing line break, for
example with `printf '%s' 'your passphrase' > pass`; one trailing line
break (LF or CRLF) is ignored, but other tools that read the same file
may not ignore it. The output file appears only after the whole copy
verified, and the tool never replaces a file that already exists. The
format is described in `docs/operations/offsite-backup-format.md`.

## Settings by environment

| Variable | Meaning |
| --- | --- |
| `BACKUP_OFFSITE_ENABLED` | `true` to copy each backup off-site |
| `BACKUP_OFFSITE_ENDPOINT` | The provider's S3 address |
| `BACKUP_OFFSITE_REGION` | Region name (`us-east-1` if unset) |
| `BACKUP_OFFSITE_BUCKET` | Bucket name |
| `BACKUP_OFFSITE_PREFIX` | Folder in the bucket (`gratisgis-<install id>/` if unset; never empty or `/`; letters, digits, `.`, `_`, `-` and `/`) |
| `BACKUP_OFFSITE_PATH_STYLE` | `false` for AWS S3 |
| `BACKUP_OFFSITE_ACCESS_KEY_ID` | Access key id |
| `BACKUP_OFFSITE_SECRET_ACCESS_KEY` or `..._FILE` | Secret access key, or a file holding it |
| `BACKUP_OFFSITE_PUBLIC_KEY` | Your public key (`ggpub1:...`) |
| `BACKUP_OFFSITE_RETENTION_DAYS` | Days to keep copies (30) |
| `BACKUP_OFFSITE_ALERT_DAYS` | Days without a good copy before a notice (3) |

Docker Compose reads `$` in `infra/.env.prod` as the start of a
variable. If the secret access key contains a `$`, put it in a file
and use `BACKUP_OFFSITE_SECRET_ACCESS_KEY_FILE` instead, or save it on
the page.

Values from the environment are checked like values typed on the page.
A refused value is shown on the page and off-site copies do not run
until it is fixed.

A secret access key from the environment is used only with the endpoint
and access key id from the environment, when those are set there. To
send copies to another endpoint, type its secret on the page. A secret
in the environment cannot be combined with an endpoint or access key id
typed on the page: with either typed there, type the secret on the page
too.
Clearing a secret saved on the page hands over to the environment's
only when the endpoint and access key id are cleared in the same save.

The endpoint must use `https`. `BACKUP_OFFSITE_ALLOW_HTTP=true` in the
server environment allows plain `http`, for a test store on a private
network only; the page cannot turn it on, it applies to endpoints from
either source, and every run logs a warning. The endpoint cannot be this
server's loopback address (such as `localhost` or `127.0.0.1`) unless
`BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT=true`, for a test store on the same
machine; every run logs a warning while it is on. A link-local address
or a cloud metadata address is refused always, also when written inside
an IPv6 address. The name is checked again
on every connection, against the address the connection uses.
Addresses on your own networks, such as other Docker containers or the
LAN, are allowed: a store there is a real use.

`infra/install.sh --check` says whether off-site backups are set up on
an existing install.
