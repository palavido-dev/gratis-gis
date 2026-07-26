// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #159 Phase 2.1 + 2.2 print-preview route.
 *
 * Phase 2.1: render real layout elements.
 * Phase 2.2: support private templates + maps (portal-api
 *            does permission resolution server-side, not via a
 *            Bearer-token-carrying chromium sidecar). Inline
 *            MapLibre snapshot replaces the iframe. Legend
 *            reads the bound map's actual layers.
 *
 * Flow:
 *   1. Chromium navigates here with ?renderToken=...
 *   2. We POST to /api/print/internal/load-job which validates
 *      the token AND returns the resolved template + map items
 *      under the original requesting user's permissions.
 *   3. We mount PrintRenderer at the template's paper size.
 *   4. The inline MapSnapshot client component sets
 *      body[data-map-ready="true"] once tiles + layers settle.
 *   5. Puppeteer's page.pdf captures the rendered HTML.
 */
import { notFound } from 'next/navigation';
import { Buffer } from 'node:buffer';
import type {
  BasemapData,
  MapData,
  PrintTemplateData,
} from '@gratis-gis/shared-types';
import { resolvePaperInches } from '@gratis-gis/shared-types';

import { PrintRenderer } from './print-renderer';

const PRIVATE_API_BASE =
  process.env.PORTAL_API_INTERNAL_URL ?? 'http://portal-api:4000';

interface Props {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<{
    map?: string;
    renderToken?: string;
    p?: string;
  }>;
}

interface JobBundle {
  userId: string;
  userDisplayName: string;
  templateId: string;
  mapId: string;
  template: { id: string; title: string; type: string; data: PrintTemplateData };
  map: { id: string; title: string; type: string; data: MapData };
  /** Phase 2.4: the resolved basemap blob for `map.data.basemap`,
   *  fetched server-side under the originating user's permissions.
   *  Null when the map has no basemap set or the basemap is no
   *  longer visible to the user; MapSnapshot falls back to a
   *  vanilla OSM raster in those cases. */
  basemap: BasemapData | null;
}

export default async function PrintPreviewPage(props: Props) {
  const { templateId } = await props.params;
  const { map: mapId, renderToken, p } = await props.searchParams;

  if (!templateId || !mapId || !renderToken) notFound();

  // Single-shot validate + load. Returns the template + map
  // items resolved with the originating user's permissions, so
  // private maps render too (Phase 2.2 unblock).
  const res = await fetch(
    `${PRIVATE_API_BASE}/api/print/internal/load-job`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: renderToken }),
      cache: 'no-store',
    },
  );
  if (!res.ok) notFound();
  const bundle = (await res.json()) as JobBundle;
  if (
    bundle.templateId !== templateId ||
    bundle.mapId !== mapId ||
    bundle.template.type !== 'print_template' ||
    bundle.map.type !== 'map'
  ) {
    notFound();
  }

  // Decode parameter values blob. Soft-fail on malformed input
  // so the renderer falls back to declared defaults.
  let parameterValues: Record<string, string> = {};
  if (p) {
    try {
      const decoded = Buffer.from(p, 'base64url').toString('utf8');
      parameterValues = JSON.parse(decoded) as Record<string, string>;
    } catch {
      parameterValues = {};
    }
  }

  const inches = resolvePaperInches(bundle.template.data.paper);

  return (
    <html lang="en">
      <head>
        <title>Print preview</title>
        <style>{`
          @page { size: ${inches.w}in ${inches.h}in; margin: 0; }
          html, body { margin: 0; padding: 0; background: white; }
          body { width: ${inches.w * 96}px; height: ${inches.h * 96}px; }
        `}</style>
      </head>
      <body>
        <PrintRenderer
          template={bundle.template.data}
          mapId={bundle.mapId}
          mapData={bundle.map.data}
          basemapData={bundle.basemap}
          parameterValues={parameterValues}
          userDisplayName={bundle.userDisplayName}
        />
      </body>
    </html>
  );
}
