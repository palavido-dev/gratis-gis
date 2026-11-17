# Recovered uncommitted audit fixes

**Crashed agent:** `bc-a930f7cf-4ac5-5c94-a743-d7c1478e5a11`  
**Transcript:** `/tmp/cursor/cloud-agent-transcripts/2026-11-08T17-09-38Z-c8f2/bc-a930f7cf-4ac5-5c94-a743-d7c1478e5a11/transcript.json`  
**Base:** `origin/palavido-dev/combined-acceptance-5a11` @ `c12f2b85`  
**Recovery branch:** `palavido-dev/recover-uncommitted-audit-5a11-a43f`

## Seven audit findings (from user message after independent audit)

1. **Offline rekey v2:** prefix incompatible with portal `decryptWithKey`; omits `org_ai_provider` / `system_setting`; keyring unused by API; commit/env crash unrecoverable.
2. **Lease trigger:** silently blocks ingest bridge handoff, stranded import sweep, and admin cancel; audit success can lie.
3. **Staging reserve:** early-return bypasses concurrency cap, returns uninserted UUID; `statfs` wrong filesystem.
4. **Operator org:** install-wide maintenance/rekey/diagnostics/readiness lack operator-org authorization; invalid explicit operator config falls back to oldest org.
5. **Post-COPY stamps:** source/count whole-document stamps can overwrite concurrent `syncVersion`/field edits.
6. **Pinned dial:** eagerly buffers up to 1GiB; gzip remains compressed while proxy omits encoding; needs backpressure / caller cap / decoded cap.
7. **ZIP reader:** unbounded inflation / unchecked method / CRC / path; accepts `../` and modified data; keep files untrusted until validated authorized preview/replay.

Bonus mid-flight bug (also fixed in recovered edits): form-mirror SQL used `f.data` instead of `f.data_json`.

## Successfully recovered (from transcript `search_replace` diffs)

| Area | Files |
|------|--------|
| Finding 1 (partial) | `infra/rekey/rekey-credentials.mjs`, `infra/rekey/rekey.test.mjs`, `infra/rekey/decrypt-check.ts`, `apps/portal-api/src/items/credential-cipher.ts` |
| Finding 2 | `apps/portal-api/src/analysis/analysis-bridge.worker.ts`, `apps/portal-api/src/admin/jobs-monitor.service.ts` |
| Finding 3 | `apps/portal-api/src/admin/resource-quota.service.ts` |
| Finding 4 | `apps/portal-api/src/backup/operator-org.ts`, maintenance/rekey/diagnostics/readiness controllers, `admin.module.ts`, rekey service org scoping |
| Finding 5 | new `apps/portal-api/src/data-layer/layer-json-patch.ts`; `tables.service.ts`, `import-jobs.worker.ts`, `ingest.controller.ts` |
| Finding 6 (partial) | `apps/portal-api/src/common/net-guards.ts`, `net-guards.live.spec.ts`, `proxy-stream.ts` |
| Finding 7 (comment only) | `infra/field-bundle/read-recovery.mjs` |
| Form mirror | `forms.service.ts`, `forms-mirror.pg.spec.ts` |
| Related pre-audit on same dirty tree | feature paging/stream/controller + specs; `.semgrep.yml`; `infra/semgrep/*`; `.github/workflows/semgrep.yml` |

**71** chronological edits extracted after clean `c12f2b85`; all applied onto this branch (net-guards and several others re-applied with a newline-safe patcher after an initial fuzzy-apply corruption).

## Could not fully recover / never emitted as edits

| Gap | Notes |
|-----|--------|
| Finding 7 ZIP validation rewrite | Only comment change exists; CRC/method/path/size caps never patched. See `docs/handoffs/recovered-audit-patches/incomplete-finding7-zip-reader.md`. |
| Proxy `safeFetch(..., { maxBytes })` call sites | Controllers grepped, not edited. See `incomplete-proxy-maxbytes-and-tests.md`. |
| Rekey `after-commit-before-env` fault + keyring retry proof | Planned in thinking; not in any diff. |
| operator-org invalid-env unit case | Planned, not written. |
| Lease/quota/stamp/zip/HTTP live regression scripts | Planned after code batch; crash mid-edit (last successful edits were `proxy-stream.ts`). |
| Cherry-picks onto source PRs (#591/#597/#599/#601/#602…) | Not started. |

## Method

1. Confirmed clean combined tip at transcript msg ~8367 (`c12f2b85`).
2. Extracted every `search_replace` tool_result unified diff under `/tmp/gg-combined` from that point through crash (~8880).
3. Replayed diffs onto matching relative paths; documented unfinished intent from assistant thinking where no tool call existed.
