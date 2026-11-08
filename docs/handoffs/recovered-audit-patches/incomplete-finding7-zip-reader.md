# Incomplete: finding (7) ZIP reader validation

## Status

**Not recovered as code.** The crashed agent only applied a comment rewrite
on `infra/field-bundle/read-recovery.mjs`. The validation rewrite was planned
in assistant notes and never issued as `search_replace` / Write tool calls.

## Intended fix (from assistant thinking, non-binding)

Target: `infra/field-bundle/read-recovery.mjs` (and tests).

- Reject zip entry methods other than store (`0`) or deflate (`8`).
- Verify CRC32 (`zlib.crc32`) against the central-directory value; reject
  modified payloads (including zero CRC with changed data).
- `safeZipName`: reject null/empty names, `\`, `/`, NUL, and `..` path
  segments (e.g. `../outside.txt`).
- Size caps (agent revised to): **32 MiB per entry**, **128 MiB total**
  uncompressed; check declared and actual inflated sizes (bomb guard).
- Keep recovered files untrusted until an authorized preview/replay path
  validates them.
- Tests: oversized inflate under a small `maxUncompressed` cap; path
  traversal fixture; CRC mismatch fixture; still accept a valid field
  export zip.

## Recovered related change

Comment-only honesty update on `infra/field-bundle/read-recovery.mjs` is
on this branch (clarifies the reader is not offline phone recovery or
auto-replay).
