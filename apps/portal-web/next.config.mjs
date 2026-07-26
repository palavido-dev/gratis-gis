// SPDX-License-Identifier: AGPL-3.0-or-later
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cache-bust static assets per deploy. Turbopack (the Next 16
  // default bundler) reuses chunk FILENAMES across builds while
  // their contents change, and /_next/static ships with a one-year
  // immutable Cache-Control -- so without this, returning browsers
  // keep executing the previous deploy's JS forever (bugfixes
  // "not taking" after deploys). deploymentId appends ?dpl=<id> to
  // every asset URL; the Docker build stage sets GG_DEPLOYMENT_ID
  // per image build. Standalone output serializes the resolved
  // config, so the runtime stage sees the same id without the env.
  ...(process.env.GG_DEPLOYMENT_ID
    ? { deploymentId: process.env.GG_DEPLOYMENT_ID }
    : {}),
  // Don't ship `x-powered-by: Next.js` on every response.  Pure
  // information disclosure, no functional reason to advertise the
  // framework + version to every visitor.
  poweredByHeader: false,
  // maplibre-gl is transpiled through Next so every importer (app code
  // plus maplibre-gl-lidar / terra-draw adapter / cog protocol) shares
  // ONE module instance. Turbopack was otherwise instantiating it twice
  // on the maps route, so maplibregl.addProtocol('pmtiles'/'cog') wrote
  // one instance's protocol registry while the map read the other's and
  // raster/DEM layers never drew (#209).
  transpilePackages: [
    '@gratis-gis/ui',
    '@gratis-gis/shared-types',
    'maplibre-gl',
  ],
  experimental: {
    // Required because our shared packages export TS directly without a build step.
    externalDir: true,
  },
  // Standalone output bundles the minimal node_modules subset that the
  // running server actually imports into a self-contained .next/standalone
  // directory. The Docker runtime stage copies that subset rather than the
  // full 1+ GB of pnpm-style node_modules, cutting the production image
  // size by ~10x. No-op for `next dev` and `next start` against a regular
  // .next build, so dev workflow is unchanged.
  output: 'standalone',
  // The standalone tracer needs to know where the workspace root is so it
  // includes packages/* deps, otherwise the build warns about multiple
  // lockfiles and may miss workspace package files at runtime.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // #118 help docs.  The /help route reads .md files from
  // content/help/ via fs at request time -- the tracer can't see
  // them (no static import), so the standalone build leaves them
  // out and prod renders an empty sidebar.  Force-include the
  // tree.  Glob is rooted at the package, not the tracing root.
  outputFileTracingIncludes: {
    '/help/**/*': ['./content/help/**/*'],
  },
};

export default nextConfig;
