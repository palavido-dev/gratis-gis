// SPDX-License-Identifier: AGPL-3.0-or-later
// Astro config for the project website at https://gratisgis.org.
// Static output only. GitHub Pages serves dist/ as is.
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://gratisgis.org',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    // /install/index.html, so /install and /install/ both resolve on Pages.
    format: 'directory',
    // Small pages: one stylesheet inline beats an extra request.
    inlineStylesheets: 'auto',
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
    }),
  ],
  // No telemetry, no dev toolbar.
  devToolbar: { enabled: false },
});
