# Off-site backup file format

Off-site copies are encrypted on the portal server before upload. A copy
must stay readable when the portal is gone, so the format is written
down here in full and can be opened with `infra/recovery/seal.mjs`
(Node.js only, no other dependencies).

## Encryption: GRCV2

This is the same format the host recovery bundles use
(`infra/recovery/seal.mjs`). Code: `apps/portal-api/src/backup/offsite-crypto.ts`.

```
header  "GRCV2\n" | logN u8 | r u8 | p u8 | chunkLog2 u8 | salt[16] | iv[12]
records ciphertext[<= chunk] | tag[16], repeated, at least one
```

- **Key:** `scrypt(passphrase, salt, N = 2^logN, r, p)`, 32 bytes. The
  passphrase is its UTF-8 bytes, nothing added. The portal writes
  `logN = 17`, `r = 8`, `p = 1`. Readers refuse `logN` above 17, `r`
  above 8 or `p` above 1, so a crafted header cannot ask for more memory
  than a real one.
- **Records:** the plaintext is cut into chunks of `2^chunkLog2` bytes
  (the portal writes `chunkLog2 = 20`, 1 MiB). Record `i` is AES-256-GCM
  with nonce `iv` XOR `be64(i)` in its last 8 bytes, and associated data
  `header | be64(i) | final`, where `final` is one byte, 1 for the last
  record and 0 otherwise.
- A plaintext of `N` bytes gives `ceil(N / chunk)` records, or one empty
  final record when `N` is 0. The encrypted size is exactly
  `38 + N + 16 * records` bytes.
- **What fails:** a changed byte, a wrong passphrase, records swapped or
  dropped, a file cut anywhere (including at a record boundary, because
  the last record left was sealed as not final), and extra bytes after
  the final record.

One backup run derives one key with a fresh random salt; every file of
that run has its own random IV. A reader caches keys by salt, so
opening many files of one run pays for scrypt once.

### Decrypt by hand

```bash
printf '%s' 'your passphrase' > /root/offsite.pass   # no trailing newline
chmod 600 /root/offsite.pass
node infra/recovery/seal.mjs dec /root/offsite.pass in.tar.gz.enc out.tar.gz
```

`seal.mjs` reads the passphrase file as raw bytes. A trailing newline
would become part of the passphrase, so write the file with `printf`,
not `echo`. `infra/restore-from-offsite.sh` drops one trailing newline
for you. Passphrases set on the portal cannot contain line breaks.

`seal.mjs dec` writes the plaintext only after every record verified.

## Bucket layout

Under the configured prefix (`gratisgis/` by default):

| Key | Content |
| --- | --- |
| `archives/<archive>.enc` | The local backup archive (`backup-<time>-<id>.tar.gz`), encrypted |
| `archives/<archive>.enc.json` | Sidecar, plain JSON, written last |
| `mirror/runs/<time>-<id>/database.dump.enc` | Mirror mode: the `pg_dump` custom-format dump, encrypted |
| `mirror/runs/<time>-<id>/manifest.json.enc` | Mirror mode: the archive's `manifest.json`, encrypted |
| `mirror/runs/<time>-<id>/objects.jsonl.enc` | Mirror mode: one JSON line per stored file, encrypted |
| `mirror/runs/<time>-<id>/done.json` | Mirror mode: sidecar, plain JSON, written last |
| `mirror/objects/<sha256>.enc` | Mirror mode: one stored file, encrypted |

A copy without its sidecar is unfinished and is never used for a
restore.

The archive sidecar:

```json
{
  "format": "GRCV2",
  "kind": "archive",
  "runId": "<uuid>",
  "archive": "backup-2026-11-24T02-00-00-000-abcdef12.tar.gz",
  "createdAt": "2026-11-24T02:00:00.000Z",
  "plainBytes": 123,
  "sealedBytes": 219,
  "sealedSha256": "<hex>"
}
```

In mirror mode, each line of `objects.jsonl` is
`{"k": "<object key>", "o": "<sha256>.enc", "s": <bytes>, "t": "<content type>"}`.
The stored file name is the SHA-256 of the object key, its size and its
ETag, so a changed file gets a new name and older runs still find the
version they recorded. The bucket never shows the portal's own file
names.

## Integrity checks on upload

- Every part of a multipart upload carries `Content-MD5`; the provider
  refuses a part that does not match.
- A returned part ETag that is a plain MD5 is compared with the part.
- The combined ETag is compared when it has the usual
  MD5-of-part-MD5s form.
- After completion the stored size is read back and must equal the
  bytes sent, which must equal the predicted encrypted size.
- The SHA-256 of the encrypted bytes is recorded on the run and in the
  sidecar. `restore-from-offsite.sh` checks it after download.

## Where the secrets live

| Secret | Stored | Never |
| --- | --- | --- |
| Bucket secret access key | `backup_config.offsite_secret_encrypted`, AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY`, AAD `backup-offsite:secret-access-key`; or `BACKUP_OFFSITE_SECRET_ACCESS_KEY(_FILE)` | Returned by the API, logged, written to the bucket |
| Encryption passphrase | `backup_config.offsite_passphrase_encrypted`, same cipher, AAD `backup-offsite:passphrase`; or `BACKUP_OFFSITE_PASSPHRASE(_FILE)` | Returned by the API, logged, written to the bucket |

The portal database dump inside each archive contains the
`backup_config` row, so it holds both secrets encrypted under
`CREDENTIAL_ENCRYPTION_KEY`. That key is not in the archive, and the
archive itself can only be opened with the passphrase.
