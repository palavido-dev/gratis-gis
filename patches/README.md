# Dependency patches

Patches applied by `pnpm` at install time. Each one is registered
under `pnpm.patchedDependencies` in the root `package.json`, so it is
reviewable as a diff and disappears the moment upstream ships the same
fix.

Regenerate a patch with `pnpm patch <name>@<version>`, edit the files
in the directory it prints, then `pnpm patch-commit <dir>`. Never edit
`node_modules` in place: that survives nothing.

## maplibre-gl-lidar@0.16.2

Swaps the library's deck.gl bridge from `MapboxOverlay`
(`@deck.gl/mapbox`) to `MapLibreOverlay` (`@deck.gl/maplibre`).

### Why

maplibre-gl 6 removed the internal `Map.transform`. `@deck.gl/mapbox`
reads `map.transform.height`, `map.transform.elevation` and
`map.transform._nearZ` / `._farZ` on every render, and 9.4.0 still
does, so a point cloud throws on first render under maplibre 6. That
blocked the whole maplibre 6 upgrade, since point clouds are the only
part of portal-web that touches deck.gl.

deck.gl shipped the repair as a separate package rather than as a fix
to the old one. `@deck.gl/maplibre` supports maplibre
`^4.5.1 || ^5 || ^6` and reads the same values through public API
(`map.getCanvas().clientHeight`, `map.getCenterElevation()`, and
`nearZ` / `farZ` off the render parameters), so its shipped `dist`
contains no `map.transform` access at all.

maplibre-gl-lidar's entire deck.gl surface is one small class,
`DeckOverlay`, which constructs the overlay with
`{ interleaved: false, layers: [] }`, hands it to `map.addControl`,
calls `setProps({ layers })`, and drops it with `map.removeControl`.
`MapLibreOverlay` implements `IControl` and exposes `setProps`, so it
is a drop-in for all four. The overlay is a private field, so no type
in the package's `.d.ts` output changes.

### What the patch touches

Three files, three hunks:

- `dist/LidarLayerAdapter-BCi-k0SS.js` (the ESM bundle): the import
  and the constructor call.
- `dist/LidarLayerAdapter-D15dhfhP.cjs` (the CJS bundle): the same two
  edits in `require` form.
- `package.json`: `@deck.gl/mapbox` in `dependencies` becomes
  `@deck.gl/maplibre`, because after the patch nothing in the package
  imports the former.

The two `.js.map` sourcemaps are deliberately left alone. They now
report a column offset two characters stale on the two edited lines,
which costs nothing and keeps the patch small enough to read.

### Two supporting entries in the root package.json

**`pnpm.packageExtensions`** also declares `@deck.gl/maplibre` on
maplibre-gl-lidar. This looks redundant against the patch's own
`package.json` hunk and is not: pnpm resolves a package's dependencies
from the registry manifest and applies patches to the extracted files
afterwards, so the patched manifest never reaches the resolver.
Verified on pnpm 9.12.0, including under `pnpm install --force`.
Without the extension the package is not linked into
maplibre-gl-lidar's own `node_modules` and the import resolves only by
falling through to pnpm's hidden hoist directory, which is a setting
away from disappearing. The patch hunk is still worth keeping so the
manifest on disk describes what the code actually imports.

**`pnpm.overrides`** pins the whole `@deck.gl/*` plus `@luma.gl/*`
stack to `~9.4.0`. `@deck.gl/maplibre@9.4.0` requires
`@deck.gl/core ~9.4.0` and `@luma.gl/core ~9.4.0`, while
maplibre-gl-lidar asks for `>=9.3.2` and would otherwise leave parts
of the stack on 9.3.x. A split stack fails at runtime with luma errors
that name neither package. These entries are compatibility pins rather
than advisory pins, so the monthly override review described in
SECURITY.md should leave them alone until this patch goes away.

`@deck.gl/mapbox` is pinned in that same block and stays in the
dependency graph, because `packageExtensions` can add a dependency but
cannot remove one. Nothing imports it. It is pinned only so the tree
holds a single deck.gl version instead of leaving one package behind
on 9.3.7 with an unsatisfiable peer range.

### One limit worth knowing

`@deck.gl/maplibre` publishes ESM only: its `exports` map has an
`import` condition and no `require` condition. So the CJS bundle this
patch edits cannot actually load under `require()`. Nothing in this
repo does. Both call sites
(`apps/portal-web/src/app/items/[id]/point-cloud/viewer.tsx` and
`apps/portal-web/src/app/items/[id]/map/point-cloud-overlay.ts`) use
`import` and `await import()`, webpack resolves those through the
`import` condition, and portal-web's jest run covers `src/lib` only,
which reaches neither file. Patching the CJS bundle anyway keeps the
two builds saying the same thing and makes a hypothetical `require()`
consumer fail loudly at load instead of quietly at first render, which
is what the unpatched CJS bundle does under maplibre 6.

### When to drop it

Delete the patch file, the `pnpm.patchedDependencies` entry, the
`pnpm.packageExtensions` entry and the `@deck.gl/mapbox` override once
maplibre-gl-lidar ships a release that uses `@deck.gl/maplibre`
itself, tracked upstream as opengeos/maplibre-gl-lidar#92. Keep the
remaining `~9.4.0` pins until the new release's own ranges require
9.4.

`@deck.gl/maplibre` also stays a direct dependency of portal-web. That
is on purpose: it is what the patched code imports, and declaring it
where it is used keeps the dependency visible to anyone auditing
portal-web rather than only to whoever reads this file.
