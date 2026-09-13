# @gratis-gis/field-engine

The form and sync logic the native field client runs, bundled as one
dependency-free JavaScript file for an embedded JS engine (QuickJS on
Android, JavaScriptCore on iOS). Background and rationale are in
`docs/mobile-field-app.md`, "The engine bundle".

Nothing in this package decides anything. It re-exposes functions from
`packages/form-schema` and `packages/shared-types` behind a flat,
string-keyed surface so a host written in another language can call
them with JSON and never reimplement them.

## Build

```
pnpm -C packages/field-engine build
```

writes:

- `dist/gratis-field-engine.js`: an IIFE targeting ES2020 that defines
  the global `GratisFieldEngine`. No imports, no `require`, no
  platform globals. About 35 KB minified.
- `dist/gratis-field-engine.js.map`
- `dist/engine-version.json`: `{ engineVersion, file, sha256, bytes,
  inputs }`. The Android build reads this into `BuildConfig`, ships
  the bundle as an asset, and refuses to start if the asset's hash
  does not match.

The bundle is built from the sibling packages' TypeScript **source**,
not their `dist`, so esbuild can tree-shake ESM modules. `turbo.json`
keeps `dependsOn: ["^build"]` on this package for cache correctness;
see the comment there.

## Calling convention

The host binds exactly one function:

```
GratisFieldEngine.call(name: string, argsJson: string): string
```

`name` is a surface name from the list below. `argsJson` is the JSON
text of that function's single argument object (`"{}"` when it takes
none). The return value is JSON text of:

```
{ "ok": true,  "result": <value> }
{ "ok": false, "error": { "code": "unknown-function" | "bad-argument" | "threw",
                          "message": string } }
```

`call` never throws. A host that has to catch a JS exception across a
JNI boundary has a crash it cannot attribute, so errors come back as
data with a code to switch on.

Everything that depends on the clock takes `nowMs` from the caller.
The form builtins `today` and `now` are the one exception, and they
are the same exception in the web client.

`GratisFieldEngine.ENGINE_VERSION` and `GratisFieldEngine.SURFACE_NAMES`
are also exposed for a host that wants them without a call.

## Surface

Names and argument shapes are shipped contract: an installed app calls
them by string. Adding a function is fine. Renaming one, or changing
an argument or result shape, needs an `ENGINE_VERSION` bump in
`packages/form-schema/src/engine-version.ts` and a line here.

| Name | Argument | Returns |
| --- | --- | --- |
| `engine.info` | `{}` | `{ engineVersion, queueClaimStaleMs, functions }` |
| `form.requirement` | `{ form }` | `EngineRequirement` (`{ version, unknown }`) |
| `form.validate` | `{ form, response }` | `ValidationResult` |
| `form.state` | `{ form, response }` | `FormState` (visible / required / readOnly per question occurrence, repeat instances as `g[0].child`) |
| `form.applyCalculations` | `{ form, response }` | updated `Response` |
| `form.pruneHidden` | `{ form, response }` | pruned `Response` |
| `form.fromLayer` | `{ layer, options }` | generated `FormSchema` |
| `feature.validate` | `{ fields?, properties?, options? }` | `ValidateFeatureResult` (persist `value`, not the input) |
| `feature.stamp` | `{ fields?, properties, context }` | stamped properties |
| `feature.isServerStampedField` | `{ name }` | boolean |
| `filter.matches` | `{ properties?, filter? }` | boolean |
| `queue.fold` | `{ prior, next }` | `FoldResult` |
| `queue.foldChain` | `{ chain }` | `FoldResult` |
| `queue.retryDelayMs` | `{ retryCount? }` | milliseconds |
| `queue.isClaimable` | `{ row, nowMs, options? }` | boolean |
| `queue.isOwnedBy` | `{ row, currentUserId }` | boolean |
| `queue.chainHeads` | `{ rows, nowMs, options? }` | the rows to replay, as given |
| `sync.outcome` | `{ status, op }` | `'done' \| 'retry' \| 'rejected'` |
| `message.sanitize` | `{ message }` | `OfflineMessageEnvelope \| null` |

Type names refer to the exports of `@gratis-gis/form-schema` and
`@gratis-gis/shared-types`; the JSON shapes are those types, verbatim.

## Tests

`pnpm -C packages/field-engine test` builds the bundle, loads it into
a bare `node:vm` context (ES builtins only: no `console`, timers,
`TextEncoder` or `fetch`), and calls every surface function through
`call`, comparing against the TypeScript run directly. A function
that works from TypeScript but not from the bundle is the bug this
exists to catch. The suite also fails if a surface function is added
without a case.

## Engine version

`ENGINE_VERSION` lives in `packages/form-schema`, not here, because
the web client and the server need it too. The rule: bump it in any
commit that changes what a form evaluates to, and register new
question types, operators and builtins with the version they arrived
in. `form.requirement` walks a form and returns the highest version it
needs; the server stamps that on the form at save; the app compares it
to the bundle it carries and refuses to capture against a form that
needs a newer engine.
