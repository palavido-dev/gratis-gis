# Dependency patches

Patches applied by `pnpm` at install time. Each one is registered
under `pnpm.patchedDependencies` in the root `package.json`, so it is
reviewable as a diff and disappears the moment upstream ships the same
fix.

Regenerate a patch with `pnpm patch <name>@<version>`, edit the files
in the directory it prints, then `pnpm patch-commit <dir>`. Never edit
`node_modules` in place: that survives nothing.

## Active patches

None. The former `maplibre-gl-lidar@0.16.2` MapboxOverlay →
MapLibreOverlay patch was dropped when portal-web moved to
maplibre-gl-lidar ^0.21.0, which depends on `@deck.gl/maplibre`
upstream (opengeos/maplibre-gl-lidar#93).
