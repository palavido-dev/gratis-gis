# Off-site backup file format

Off-site copies are encrypted on the portal server before upload, to the
admin's public key. The server holds only that public key, so it can
make copies but cannot read any of them. A copy must stay readable when
the portal is gone, so the formats are written down here in full, and
`infra/recovery/offsite-key.mjs` (one file, Node.js 20 or newer, no
other dependencies) reads and writes all of them.

Code: `apps/portal-api/src/backup/offsite-crypto.ts` (backup files and
keys) and `apps/portal-api/src/backup/offsite-grcv2.ts` (the sealed key
file).

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
  "fingerprint": "xxxx-xxxx-..."
}
```

`d` is the raw X25519 private key; `check` is the first 4 bytes of
`SHA-256("gratisgis-offsite-private-key-v1" 0x00 | d)`. A reader derives
the public key from `d` and refuses the file when it differs from
`publicKey`.

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

**What the format does not prove.** It does not say who made a file.
Anyone with the public key can write a valid file, and the public key
is not secret. The sidecar and `done.json` are plain JSON in the same
bucket, and the run row that also records the checksum is not on a new
server at restore time. So the checksums catch damage (a cut-short or
corrupted download), not a deliberate change: anyone who can write to
the bucket can add a copy that looks complete and decrypts with your
key. What protects the copies is who can write to the bucket:

- Use a bucket key that only this portal has, made for this bucket
  alone and not kept or reused anywhere else.
- Turn on versioning or object lock at the provider, so a copy that was
  replaced or deleted can still be got back.
- Restore a copy dated before any suspected break-in. The restore tool
  shows the chosen copy's name, date, size and key fingerprint and asks
  for confirmation before it changes anything. It never picks a copy
  whose name is dated in the future (or more than an hour after the
  provider recorded the upload) as the newest; such a copy is used only
  when named, with a warning.
- The dump is restored by the database's owner role, which in the
  default install is a superuser, and a dump can hold any SQL that role
  may run. If a copy's origin is in doubt, list it first
  (`pg_restore -l`), restore it on a spare server, or restore with a
  role that is not a superuser where your setup allows it.

**Planned.** A later format version may add a signature, so a restore
can tell a copy this portal made from one it did not.

### Decrypt by hand

With only Node.js and `offsite-key.mjs`:

```bash
node offsite-key.mjs decrypt my-portal.ggkey \
  backup-2026-11-24T02-00-00-000-abcdef12.tar.gz.enc backup.tar.gz
```

It asks for the passphrase on the terminal, or takes
`--passphrase-file FILE`, or reads it from standard input when that is
not the data. `IN` and `OUT` may be `-` for standard input and output;
then give the passphrase with `--passphrase-file`. Written to a file,
the output appears only after every record verified. Written to
standard output, bytes come out as they verify: if the command fails,
discard what it wrote.

Other commands: `public KEYFILE` (prints the public key and fingerprint,
after asking for the passphrase), `fingerprint PUBLICKEY`, and
`encrypt PUBLICKEY IN OUT` (writes GROF1, for testing a key).

## Bucket layout

Under the configured folder (default `gratisgis-<first 8 hex of the
install id>/`, so every portal gets its own; never empty, so never the
whole bucket):

| Key | Content |
| --- | --- |
| `gratisgis-install.json` | Which portal owns the folder: `{"kind": "gratisgis-offsite-folder", "installId": "...", "createdAt": "..."}`, plus `takenOverFrom` when an admin took the folder over after a restore. A portal stops, without deleting anything, when the folder belongs to another install id. |
| `archives/<archive>.enc` | The local backup archive (`backup-<time>-<id>.tar.gz`), GROF1 |
| `archives/<archive>.enc.json` | Sidecar, plain JSON, written last |
| `mirror/runs/<time>-<id>/database.dump.enc` | Mirror mode: the `pg_dump` custom-format dump, GROF1 |
| `mirror/runs/<time>-<id>/manifest.json.enc` | Mirror mode: the archive's `manifest.json`, GROF1 |
| `mirror/runs/<time>-<id>/objects.jsonl.enc` | Mirror mode: one JSON line per stored file, GROF1 |
| `mirror/runs/<time>-<id>/done.json` | Mirror mode: sidecar, plain JSON, written last |
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
  "sealedSha256": "<hex>"
}
```

The mirror `done.json` has the same `format`, `runId`, `installId` and
`keyFingerprint`, plus `database` (`name`, `sealedBytes`,
`sealedSha256`), `index` (`files`, `sealedSha256`), `uploaded` and
`reused`.

### Mirror file names and the local index

Each line of `objects.jsonl` is
`{"k": "<object key>", "o": "<name>.enc", "s": <bytes>, "t": "<content type>"}`.

The name of a mirrored file is

```
HMAC-SHA-256(nameKey, "v1" 0x00 | hex(fingerprint) 0x00 | key 0x00 | size 0x00 | etag)
```

in hex, where `nameKey` is 32 random bytes made once per portal and
stored with the credential cipher (`backup_config.offsite_name_key_*`).
Without that key a name says nothing about the file: it is not a hash
of the content or of the file's key. A changed file, or a new public
key, gives a new name, so older runs keep the version they recorded and
nothing is overwritten with a file encrypted to another key.

The server cannot read the bucket back, so it keeps its own record of
what it uploaded: the `backup_offsite_object` table (one row per file:
folder hash, name, key fingerprint, sizes, content type, and the newest
run that referred to it). A file is reused only when its row matches
the current key and size and the bucket listing shows it with the
recorded encrypted size. A missing or emptied table means "upload
everything again", never a failure. Clean-up works from the bucket
listing and this table only: a file is removed when its newest run is
older than every retained complete run, and the row goes before the
file. Files the table does not know (after a restore, for example) are
kept and counted in the log; a bucket lifecycle rule can expire them.

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
  sidecar. The restore helper checks it after download. This catches
  damage, not a deliberate change: see "What the format does not
  prove" above.

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

The database dump inside each copy contains the `backup_config` row, so
it holds the bucket secret and the naming key, encrypted under
`CREDENTIAL_ENCRYPTION_KEY`, which is not in the copy.

A restore inside the portal keeps the live server's off-site settings
(public key, bucket settings, install id, naming key) instead of the
archive's, and empties `backup_offsite_object`, since the archive's copy
of it is older than the bucket. `restore-from-offsite.sh` also empties
it, turns off-site copies off and clears the install id, so the
restored server makes a new one and does not own the folder until an
admin takes it over on Admin, Backup.

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
9. Replace the public key: the next copy carries the new fingerprint;
   the older copy still decrypts with the old key file. The operator
   admins get a notice, and the page says who changed the key and when.
10. After step 8, turn off-site copies on on the restored server: the
    first copy is refused because the folder belongs to the old install.
    Take the folder over on the page; the next copy succeeds.
