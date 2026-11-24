# Off-site backup file format

Off-site copies are encrypted on the portal server before upload, to the
admin's public key. The server holds only that public key, so it can
make copies but cannot read any of them. A copy must stay readable when
the portal is gone, so the formats are written down here in full, and
`infra/recovery/offsite-key.mjs` (one file, Node.js 20 or newer, no
other dependencies) reads and writes all of them.

Code: `apps/portal-api/src/backup/offsite-crypto.ts` (backup files and
keys), `apps/portal-api/src/backup/offsite-sign.ts` (signatures) and
`apps/portal-api/src/backup/offsite-grcv2.ts` (the sealed key file).

## Keys

The key pair is X25519. It is made on the admin's own computer:

```bash
node offsite-key.mjs generate my-portal.ggkey
```

### Public key text form

```
ggpub1:<base64url( pub[32] | check[4] )>
```

- `pub` is the raw 32-byte X25519 public key.
- `check` is the first 4 bytes of
  `SHA-256("gratisgis-offsite-public-key-v1" 0x00 | pub)`.
- base64url without padding: always 48 characters, so the whole text is
  55 characters. White space anywhere is ignored when it is read back.
- `ggpub1` is the version. A reader refuses other versions by name.

### Fingerprint

```
fp = first 16 bytes of SHA-256("gratisgis-offsite-key-fingerprint-v1" 0x00 | pub)
```

Shown as 32 lower-case hex digits in groups of four joined by `-`, for
example `8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184` (the fingerprint of 32
bytes of `0x07`). It is shown wherever the key is shown, recorded on
every backup run (`backup_run.offsite_key_fingerprint`), written into
each sidecar, and stored in each file's header as the key id.

### Private key file (`.ggkey`)

The private key never reaches the portal server, except on a server
being restored, where `restore-from-offsite.sh` reads it from a file.
The file is the GRCV2 format below (the format of `seal.mjs`), sealed
with the admin's passphrase, around this JSON:

```json
{
  "kind": "gratisgis-offsite-private-key",
  "version": 1,
  "privateKey": "ggsec1:<base64url( d[32] | check[4] )>",
  "publicKey": "ggpub1:...",
  "fingerprint": "xxxx-xxxx-...",
  "verifyKeys": ["ggver1:...", "ggver1:..."]
}
```

`d` is the raw X25519 private key; `check` is the first 4 bytes of
`SHA-256("gratisgis-offsite-private-key-v1" 0x00 | d)`. A reader derives
the public key from `d` and refuses the file when it differs from
`publicKey`.

`verifyKeys` (optional, at most 64) lists the verify keys of the
portals whose signed copies this key file accepts (see Signatures
below). `offsite-key.mjs trust KEYFILE NEWFILE ggver1:...` adds to it:
it opens the file, keeps the keys already there, adds the new ones,
and seals the result with the same passphrase into a new file, created
with an exclusive create so it never replaces one. A file without the
field trusts no verify key. A reader refuses the file when the list or
any entry in it is not valid.

**Passphrase rules.** One trailing line break (`\n` or `\r\n`) is
dropped, then the text is normalised to Unicode NFC, then its UTF-8
bytes are the GRCV2 passphrase. It must be at least 16 characters, with
no line breaks or other control characters. So the same words typed on
Windows, macOS or Linux, or saved in a file by any editor, open the
file. `seal.mjs` reads its passphrase file as raw bytes, without these
rules; to open a key file with it, write the passphrase with
`printf '%s'` (no trailing newline), already in NFC.

## GRCV2 (key files)

```
header  "GRCV2\n" | logN u8 | r u8 | p u8 | chunkLog2 u8 | salt[16] | iv[12]
records ciphertext[<= chunk] | tag[16], repeated, at least one
```

- **Key:** `scrypt(passphrase, salt, N = 2^logN, r, p)`, 32 bytes.
  Writers use `logN = 17`, `r = 8`, `p = 1`, `chunkLog2 = 20`. Readers
  refuse `logN` outside 14 to 17, `r` above 8, `p` above 1 and
  `chunkLog2` outside 12 to 20.
- **Records:** as for GROF1 below, under the scrypt key.

## GROF1 (backup files)

Every encrypted file in the bucket (`*.enc`) is GROF1.

```
offset  size  field
0       6     magic "GROF1\n"
6       1     chunkLog2 (writers use 20: 1 MiB records)
7       16    keyId: the recipient key's fingerprint
23      32    ephemeral: X25519 public key made for this file only
55      32    wrappedKey: the data key, encrypted
87      16    wrapTag: GCM tag of wrappedKey
103     12    iv: base nonce for the records
115           records: ciphertext[<= chunk] | tag[16], repeated, at least one
```

### Wrapping the data key

For each file:

1. `dataKey` = 32 random bytes.
2. A new X25519 key pair `(e, E)`; `E` goes in the header as `ephemeral`.
3. `shared = X25519(e, recipientPublic)`. An all-zero result is refused
   (it comes from a low-order point), by the reader too.
4. `wrapKey = HKDF-SHA-256(ikm = shared, salt = E | recipientPublic,
   info = "gratisgis-offsite-v1 data key wrap", length = 32)`.
5. `wrappedKey | wrapTag = AES-256-GCM(key = wrapKey, nonce = 12 zero
   bytes, aad = header bytes 0 to 54, plaintext = dataKey)`. A zero
   nonce is safe because each `wrapKey` is used once.

To read: check the magic and `chunkLog2`; compare `keyId` with your
key's fingerprint (a mismatch names the key the file needs); compute
`shared = X25519(recipientPrivate, ephemeral)`, refuse all zeros, derive
`wrapKey` the same way and open `wrappedKey`.

This is the construction of the `age` X25519 recipient stanza, with
AES-256-GCM in place of ChaCha20-Poly1305 because Node.js has it built
in. Both public keys are bound into the HKDF salt, and the header up to
the ephemeral key is bound into the wrap.

### Records

The plaintext is cut into chunks of `2^chunkLog2` bytes. Record `i`
(from 0) is:

```
AES-256-GCM(key = dataKey, nonce = iv XOR be64(i) in the last 8 bytes,
            aad = header[0..115] | be64(i) | final u8)
```

where `final` is 1 for the last record and 0 otherwise. A plaintext of
`N` bytes gives `ceil(N / chunk)` records, or one empty final record
when `N` is 0. The encrypted size is exactly `115 + N + 16 * records`.

**What fails to decrypt:** the wrong private key; a changed byte in the
header, the wrapped key or any record; records swapped or dropped; a
file cut anywhere, including exactly at a record boundary (the last
record left was sealed as not final); and bytes after the final record.

**What the format alone does not prove.** It does not say who made a
file: anyone with the public key, which is not secret, can write a
valid file. The signature below does.

## Signatures

Each copy is signed by the portal with Ed25519 (RFC 8032, Node's
built-in `crypto`). The signing key is made on the portal server the
first time off-site copies are set up, or when an operator admin asks
for a new one, and is stored there, encrypted (see "Where key material
and secrets live"; the database dump in every copy holds it, still
encrypted under `CREDENTIAL_ENCRYPTION_KEY`, which is not in the copy). Its public half, the **verify key**, goes into the
admin's key file. What is signed is a short manifest that names the
copy, not the copy itself; the manifest holds the SHA-256 of the
encrypted bytes, so the copy is bound through it.

### Verify key text form and fingerprint

```
ggver1:<base64url( pub[32] | check[4] )>
check = first 4 bytes of SHA-256("gratisgis-offsite-verify-key-v1" 0x00 | pub)
fp    = first 16 bytes of SHA-256("gratisgis-offsite-verify-key-fingerprint-v1" 0x00 | pub)
```

`pub` is the raw 32-byte Ed25519 public key. The fingerprint is shown
like the public key's. Test vector: the seed of 32 bytes of `0x07`
gives `ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX`,
fingerprint `058d-7940-89ab-a15b-eb25-76ac-2168-1b43`.

### Manifest bytes

ASCII, one field per line, every line ending in `0x0a` (including the
last), no other white space, no `0x0d`:

```
gratisgis-offsite-signed-v1
<field>=<value>
...
```

The fields of each kind, in exactly this order:

| Archive | Mirror run |
| --- | --- |
| `kind=archive` | `kind=mirror` |
| `format=GROF1` | `format=GROF1` |
| `install=<install id>` | `install=<install id>` |
| `prefix=<folder>` | `prefix=<folder>` |
| `name=archives/<archive>.enc` | `run=<time>-<id>` |
| `bytes=<encrypted size>` | `created=<time>` |
| `sha256=<SHA-256 of the encrypted bytes>` | `key=<public key fingerprint>` |
| `key=<public key fingerprint>` | `dump.name`, `dump.bytes`, `dump.sha256` |
| `created=<time>` | `manifest.name`, `manifest.bytes`, `manifest.sha256` |
| | `index.name`, `index.bytes`, `index.sha256`, `index.files` |

Value rules, checked when signing and when reading:

- `install`: a UUID, lower case, 36 characters.
- `prefix`: the portal folder, 2 to 200 characters, ending in `/`;
  parts of `A-Z a-z 0-9 . _ -` other than `.` and `..`.
- `name` and `*.name`: the object name under the folder, at most 300
  characters, parts as above joined by `/`. In a mirror run they must
  be `mirror/runs/<run>/database.dump.enc`, `.../manifest.json.enc` and
  `.../objects.jsonl.enc` of the same run.
- `run`: `<YYYY-MM-DD>T<HH-MM-SS-mmm>-<8 hex>`.
- `bytes`, `*.bytes`, `index.files`: decimal, no leading zero, at most
  2^53 - 1.
- `sha256`, `*.sha256`: 64 lower-case hex digits.
- `key`: the public key fingerprint as shown (`xxxx-xxxx-...`).
- `created`: `YYYY-MM-DDTHH:MM:SS.mmmZ` exactly (24 characters), the
  time the backup run started.

A reader parses the text, rebuilds it from the parsed fields and
refuses it unless the two are byte for byte equal, so each manifest has
exactly one byte form. Test vector: the archive manifest with
`install=0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f0`,
`prefix=gratisgis-0f1e2d3c/`,
`name=archives/backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc`,
`bytes=254`, `sha256=abab...ab` (32 times `ab`),
`key=8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184`,
`created=2026-11-24T02:00:00.000Z` is 350 bytes with SHA-256
`400691dacd7403981b1b42c00c80bfaeb63c31a8478ebd0bd247d71ae462b17c`;
signed with the seed above it gives
`f_gviI8Mdohf0m-2-Urp_UsRKJrbpOlgok_WrMQyUJKZcpTOX6GJxj7CndoU_h3shqctW4u8DMlQ7LzwIC4ACg`.

### Signature block

The sidecar (`archives/<archive>.enc.json`) and a mirror run's
`done.json` carry:

```json
"signature": {
  "version": 1,
  "manifest": "<the manifest text, exactly the signed bytes>",
  "value": "<Ed25519 signature of those bytes, base64url, 86 characters>",
  "verifyKey": "<fingerprint of the verify key>"
}
```

Only the signed manifest is trusted. The other fields of the sidecar
or `done.json` (`sealedSha256`, `database.name` and so on) are
informational. They are never used for a size or checksum check, or
for the database name, when the signature verified with a key in the
key file, whatever the copy's install id.

### Checking a copy

A copy is **verified** when its signature block is present and
well formed, `verifyKey` names a verify key the reader trusts, the
signature verifies over the manifest bytes, and the manifest matches
where the copy was found: same kind, same folder, and the archive
name and listed size (or the run name and its object names). The
restore also expects `install` to be the folder marker's install id,
its `takenOverFrom` or one of its `previousInstallIds`; a copy signed
for another install is reported as such.

Then, before decrypting, every object is downloaded and its size and
SHA-256 compared with the signed values: the archive with `bytes` and
`sha256`; a mirror run's dump, manifest and file index with theirs; and
each mirrored file with the `z` and `h` of its line in the file index,
which is itself bound by `index.sha256`. A download stops as soon as it
is larger than the signed size. The checked bytes are the ones
decrypted (the helper reads them back through the same open file). For
a mirror run, `fetch-mirror` also lists the bucket and checks that
every file the index names is there with its `z` size, before the
restore script changes anything; each file's SHA-256 is checked again
when it is put back.

Readers tell apart: **verified**; **foreign** (the signature verified
with a trusted verify key, but for another install); **untrusted**
(names a verify key the reader does not hold, so the signature is not
checked and the named key is only a claim); **unsigned** (no block, as
copies made before signing); and **bad** (anything else). A foreign
copy is checked against its signed manifest exactly like a verified
one: only its install id is in doubt. Untrusted and unsigned copies
have only the unsigned fields to check against, which catches damage
but not a deliberate change.

The restore uses a verified copy without asking. With none, it offers
the newest foreign copy, then the newest untrusted one, then the newest
unsigned one, and uses it only with that state's own flag, or after its
word is typed in a terminal: `--allow-foreign-install` (`FOREIGN`),
`--allow-untrusted-signer` (`UNTRUSTED`), `--allow-unsigned-copy`
(`UNSIGNED`). A flag admits only its own state. The helper exits with
status 3 and prints `needs=<state>` when the flag is missing. A bad
copy is never used.

**What signing covers.** Binding the name, folder, install id, size,
checksum and time stops a copy from being changed, renamed, moved to
another folder or portal, or presented as newer than it is. It does not
stop someone with the bucket keys from deleting copies (use bucket
versioning or object lock), or from putting back an older genuine copy
under its own name: the restore shows each copy's date and asks for
confirmation. It protects when only the bucket credentials leak. When
the portal server itself is taken over, the signing key is taken with
it, and copies signed from then on prove nothing.

Other rules that still apply:

- Use a bucket key that only this portal has, made for this bucket
  alone and not kept or reused anywhere else.
- Turn on versioning or object lock at the provider, so a copy that was
  replaced or deleted can still be got back.
- Restore a copy dated before any suspected break-in. The restore tool
  shows the chosen copy's name, date, size, key fingerprint and the
  verify key that signed it, and asks for confirmation before it
  changes anything. It never picks a copy whose name is dated in the
  future (or more than an hour after the provider recorded the upload)
  as the newest; such a copy is used only when named, with a warning.
- The dump is restored by the database's owner role, which in the
  default install is a superuser, and a dump can hold any SQL that role
  may run. If a copy's origin is in doubt, list it first
  (`pg_restore -l`), restore it on a spare server, or restore with a
  role that is not a superuser where your setup allows it.

### Decrypt by hand

With only Node.js and `offsite-key.mjs`:

```bash
node offsite-key.mjs decrypt my-portal.ggkey \
  backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc backup.tar.gz
```

With `--sidecar backup-....tar.gz.enc.json` it first checks the
signature against the verify keys in the key file and the sidecar's
name against the signed name. Then it reads the copy once: the size and
SHA-256 are checked while the copy is decrypted into a temporary file
next to the output, and the output file appears (by rename) only when
they matched the signed record and every record decrypted. Otherwise
the temporary file is removed and no output is left. `-` is not
accepted for the copy or the output with `--sidecar`. `verify KEYFILE SIDECAR [COPY]` does
the checks without decrypting; for a mirror run give its `done.json`
and one of its three files.

It asks for the passphrase on the terminal, or takes
`--passphrase-file FILE`, or reads it from standard input when that is
not the data. `IN` and `OUT` may be `-` for standard input and output;
then give the passphrase with `--passphrase-file`. Written to a file,
the output appears only after every record verified. Written to
standard output, bytes come out as they verify: if the command fails,
discard what it wrote.

Other commands: `public KEYFILE` (prints the public key, its
fingerprint and the trusted verify keys, after asking for the
passphrase), `fingerprint PUBLICKEY|VERIFYKEY`,
`trust KEYFILE NEWFILE VERIFYKEY...` (see above), and
`encrypt PUBLICKEY IN OUT` (writes GROF1, for testing a key).

## Bucket layout

Under the configured folder (default `gratisgis-<first 8 hex of the
install id>/`, so every portal gets its own; never empty, so never the
whole bucket):

| Key | Content |
| --- | --- |
| `gratisgis-install.json` | Which portal owns the folder: `{"kind": "gratisgis-offsite-folder", "installId": "...", "createdAt": "..."}`, plus `takenOverFrom` when an admin took the folder over after a restore. A portal stops, without deleting anything, when the folder belongs to another install id. |
| `archives/<archive>.enc` | The local backup archive (`backup-<time>-<id>.tar.gz`), GROF1 |
| `archives/<archive>.enc.json` | Sidecar, plain JSON with the signature, written last |
| `mirror/runs/<time>-<id>/database.dump.enc` | Mirror mode: the `pg_dump` custom-format dump, GROF1 |
| `mirror/runs/<time>-<id>/manifest.json.enc` | Mirror mode: the archive's `manifest.json`, GROF1 |
| `mirror/runs/<time>-<id>/objects.jsonl.enc` | Mirror mode: one JSON line per stored file, GROF1 |
| `mirror/runs/<time>-<id>/done.json` | Mirror mode: sidecar, plain JSON with the signature, written last |
| `mirror/objects/<name>.enc` | Mirror mode: one stored file, GROF1 |

A copy without its sidecar is unfinished and is never used for a
restore. Only these exact names count: `archives/backup-<YYYY-MM-DD>T<HH-MM-SS-mmm>-<8 hex>.tar.gz.enc`
(and `.json`), and mirror run folders `<YYYY-MM-DD>T<HH-MM-SS-mmm>-<8 hex>/`.
Anything else, including names in sub-folders, is ignored by retention
and by the restore tool. A copy dated after now (plus one hour), or more
than an hour after the provider's own date for it, is kept, reported to
the operator admins, and never counted as the newest copy.

The archive sidecar:

```json
{
  "format": "GROF1",
  "kind": "archive",
  "runId": "<uuid>",
  "installId": "<uuid>",
  "keyFingerprint": "xxxx-xxxx-...",
  "archive": "backup-2026-11-24T02-00-00-000-abcdef12.tar.gz",
  "createdAt": "2026-11-24T02:00:00.000Z",
  "plainBytes": 123,
  "sealedBytes": 254,
  "sealedSha256": "<hex>",
  "signature": { "version": 1, "manifest": "...", "value": "...", "verifyKey": "..." }
}
```

The mirror `done.json` has the same `format`, `runId`, `installId` and
`keyFingerprint`, plus `database` (`name`, `sealedBytes`,
`sealedSha256`), `index` (`files`, `sealedSha256`), `uploaded`,
`reused` and `signature`. Copies made before signing have no
`signature`.

### Mirror file names and the local index

Each line of `objects.jsonl` is
`{"k": "<object key>", "o": "<name>.enc", "s": <bytes>, "t": "<content type>", "z": <encrypted bytes>, "h": "<SHA-256 of the encrypted file>"}`.
In a signed run every line has `z` and `h`; the restore refuses a line
without them.

The name of a mirrored file is 32 random bytes in hex, drawn new for
every upload and never one the bucket listing already shows. An
uploaded file is never replaced: a file that is new, changed, encrypted
to a new public key, or missing from the local index is uploaded again
under a new name, and whatever an earlier run refers to stays as it
was. The name says nothing about the file.

The server cannot read the bucket back, so it keeps its own record of
what it uploaded: the `backup_offsite_object` table (one row per
uploaded file: folder hash, name, source, key fingerprint, sizes,
SHA-256 of the encrypted file, content type, and the newest run that
referred to it). `source` says which stored file and version a row
holds:

```
HMAC-SHA-256(nameKey, "v1" 0x00 | hex(fingerprint) 0x00 | key 0x00 | size 0x00 | etag)
```

in hex, where `nameKey` is 32 random bytes made once per portal and
stored with the credential cipher (`backup_config.offsite_name_key_*`).
It is never written to the bucket. A file is reused only when the
newest row for its source matches the current key and size, has its
SHA-256 recorded, and the bucket listing shows that row's name with the
recorded encrypted size. A missing or emptied table means "upload
everything again under new names", never a failure or a replaced file.
The `backup_offsite_mirror_run` table lists the mirror runs this
server started, written before a run uploads anything.

Clean-up works from the bucket listing and these tables only. Every
sidecar and `done.json` it needs is read first; one that cannot be read
or parsed stops the pass with nothing deleted, and the operator admins
are told (at most once a day). Then:

- A file with a row is removed when its newest run is older than every
  retained complete run; the row goes before the file.
- A file the table does not know (left by a lost or emptied index, a
  restore, or a run stopped half way) may still be named by a run made
  before the index was lost. It is removed only when every run folder
  in the bucket is listed in `backup_offsite_mirror_run`, so that no
  run in the bucket can name it, and only when the bucket dates it more
  than 7 days back; at most 1000 such files per pass. Until the older
  runs age out of the retention window, these files are kept and
  counted in the log. No bucket lifecycle rule is needed for them; do
  not add one that deletes `mirror/objects/` by age, since a file can
  stay in use by new runs long after it was uploaded.
- No file is collected while another upload may be running, or while
  copies were left unchecked in the pass (below).

Copies set aside (dated in the future, or more than an hour after the
provider's date, or with a bad signature) are kept and never counted as
the newest. Each pass reads at most 100 badly signed sidecars or
`done.json` files of each kind, newest first; older complete copies are
then left for a later pass (kept, not deleted) and no file is
collected. One summary notice per pass gives the counts and up to 20
names; the same set of copies is not announced twice.

## Integrity checks on upload

- Every part of a multipart upload carries `Content-MD5`; the provider
  refuses a part that does not match.
- A returned part ETag that is a plain MD5 is compared with the part.
- The combined ETag is compared when it has the usual MD5-of-part-MD5s
  form.
- After completion the stored size is read back and must equal the
  bytes sent, which must equal the predicted encrypted size (for
  mirrored files too).
- The SHA-256 of the encrypted bytes is recorded on the run and in the
  signed manifest. The restore helper checks it after download and
  before decrypting (see Signatures above).

Every request to the bucket has time limits: 30 seconds to connect, 2
minutes without a byte in either direction, and 15 minutes (longer for
a large part) until the answer starts. A whole upload may take 2 hours
plus the time to send its bytes at 256 KiB/s; past that it is stopped
and marked failed, and the next upload can start. The S3 client
connects only to addresses the endpoint rules allow, checked on the
lookup the connection itself uses.

## Where key material and secrets live

| What | Where | Never |
| --- | --- | --- |
| Private key and its passphrase | The admin's `.ggkey` file and their own records. On a server being restored, only for the duration of `restore-from-offsite.sh`, which sends the key file and the passphrase to the restore helper on its standard input. | On the running portal, in its database, in the bucket, in the API, in logs |
| Public key | `backup_config.offsite_public_key` or `BACKUP_OFFSITE_PUBLIC_KEY` | Treated as a secret |
| Bucket secret access key | `backup_config.offsite_secret_encrypted`, AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY`, with a hash of the endpoint and access key id bound in as AAD; or `BACKUP_OFFSITE_SECRET_ACCESS_KEY(_FILE)` | Returned by the API, logged, written to the bucket |
| Mirror naming key | `backup_config.offsite_name_key_encrypted`, same cipher, AAD `backup-offsite:mirror-name-key` | Returned by the API, logged, written to the bucket |
| Signing key (Ed25519 seed) | `backup_config.offsite_signing_key_encrypted` and `_iv`, same cipher, AAD `backup-offsite:signing-key`; checked on every load against the stored verify key | Returned by the API, logged, in a notice or audit row, written to the bucket as such |
| Verify key (public) | `backup_config.offsite_verify_key`; earlier ones in `offsite_previous_verify_keys`; the admin's key file (`verifyKeys`); the fingerprint on each run (`backup_run.offsite_verify_fingerprint`) and in each signature block | Treated as a secret |

The database dump inside each copy contains the `backup_config` row, so
it holds the bucket secret, the naming key and the signing key,
encrypted under `CREDENTIAL_ENCRYPTION_KEY`, which is not in the copy.
The copy itself is encrypted to the admin's key on top of that.

A stored signing key that no longer opens (the server key changed) or
does not match its verify key is replaced by a new one, and the
operator admins are told that the server replaced it by itself. Its
stored verify key is not kept as an earlier key, since nothing shows it
belonged to the key in use. A key replaced by an admin keeps its verify
key in the earlier keys (the last 20), so the server's retention still
counts the copies it signed. A replacement is written only if the
stored key is still the one read, so two at once cannot lose a key.

A restore inside the portal keeps the live server's off-site settings
(public key, bucket settings, install id, naming key, signing key and
verify keys) instead of the archive's, and empties
`backup_offsite_object` and `backup_offsite_mirror_run`, since the
archive's copy of them is older than the bucket. A signing key from an
archive is never kept: when the live server had none, the columns stay
empty and it makes a new one.
`restore-from-offsite.sh` also empties both, turns off-site copies off,
clears the install id, and removes the signing key that came with the
dump (moving its verify key to the earlier keys), so the restored
server makes its own signing key and a new install id, and does not
own the folder until an admin takes it over on Admin, Backup. Taking a
folder over records the previous owner in the marker's `takenOverFrom`
and `previousInstallIds`.

The bucket secret from `BACKUP_OFFSITE_SECRET_ACCESS_KEY(_FILE)` is
used only with the endpoint and access key id from the environment
when those are set there, and never in place of a saved secret that no
longer opens.

## Manual test with a real second store

The automated tests use an in-memory store. Before relying on off-site
copies with a new provider, run this once against a real bucket:

1. Make a key pair with `offsite-key.mjs generate`; paste the public key
   on Admin, Backup; check it with **Check my key**.
2. Fill in the bucket settings; **Test connection** must pass.
3. Turn off-site copies on and run a backup. The run shows "Off-site:
   copied" and the key fingerprint. In the bucket: the folder marker, the
   `.enc` archive and its `.json` sidecar. Download the `.enc` and check
   it does not start with `PK` or contain readable SQL.
4. Decrypt it with `offsite-key.mjs decrypt` on another computer and
   compare its SHA-256 with the local archive's.
5. Set a wrong secret access key: the next copy is marked failed, a
   notice arrives, the local backup still succeeds.
6. Set retention to 1 day, wait a day, run two backups: the older copy
   is removed and the newest good one kept.
7. With a store over the mirror threshold (or the threshold lowered to
   1 GB on a test install): two runs, the second uploads only new or
   changed files.
8. On a fresh server, with only the env file, the key file and its
   passphrase: `restore-from-offsite.sh --list`, then a full restore.
   The printed counts match the original portal.
9. Add the verify key from the page with `offsite-key.mjs trust`, then
   `offsite-key.mjs verify` the downloaded copy and its sidecar.
   **Make a new signing key**: the next copy is signed with it; a
   restore refuses it as untrusted until the new verify key is added.
10. Replace the public key: the next copy carries the new fingerprint;
   the older copy still decrypts with the old key file. The operator
   admins get a notice, and the page says who changed the key and when.
11. After step 8, turn off-site copies on on the restored server: the
    first copy is refused because the folder belongs to the old install.
    Take the folder over on the page; the next copy succeeds.
