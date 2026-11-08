# Incomplete: proxy maxBytes wiring, rekey fault, and regression tests

## Status

Partially implemented in recovered `net-guards.ts` / `proxy-stream.ts`, but
**call-site wiring and several tests never became tool calls** before crash.

## Recovered

- `safeFetch(url, init, options?: { maxBytes?: number })` threads options
  through `connectPinned` / transport / `pinnedRequest`.
- Pull-based paused body read with decoded + compressed caps; request
  stream body limited via `Transform`.
- `DEFAULT_MAX_PROXY_BYTES` exported from `proxy-stream.ts`; comment updated
  for decompress/strip encoding behavior.

## Not recovered (planned, no edit tool calls)

1. **Proxy controllers** — `apps/portal-api/src/public/public-proxy.controller.ts`
   and `apps/portal-api/src/items/item-proxy.controller.ts` were grepped but
   never patched to pass `maxBytes: DEFAULT_MAX_PROXY_BYTES` (or 64 MiB) into
   `safeFetch`.
2. **Rekey `after-commit-before-env` fault** — planned on
   `infra/rekey/rekey-credentials.mjs` + `rekey.test.mjs` to prove keyring
   decrypt when env still holds the old key after COMMIT. Not present in
   any applied diff (existing faults: `before-commit`, `after-keyring`,
   `pause-before-commit` only).
3. **operator-org.spec** — case for invalid explicit `GRATIS_OPERATOR_ORG_ID`
   returning null (fail-closed) was planned, not written.
4. **Live regression harnesses** — lease-trigger / quota two-session /
   stamp interleaving / zip / HTTP backpressure scripts and Jest additions
   queued after the code edits; crash interrupted before those Write calls.
5. **Source-PR propagation** — agent intended to cherry-pick combined-tree
   fixes back onto #591/#597/#599/#601/#602 etc.; never started.
