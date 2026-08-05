# OSGeo Project Submission: GratisGIS

A copy-from reference for filling out the OSGeo "Add a Project" form at
https://www.osgeo.org/community/getting-started-osgeo/add-a-project/

Everything below is prepared text you can paste straight into the form fields.
Items in **[BRACKETS]** are things only you can supply (your OSGeo User ID,
final URLs you want to use, etc.). Public-facing copy uses neutral framing and
does not name any commercial product, per your standing preference.

---

## 0. Before you touch the form (the prerequisite steps)

The form itself is the last step. The submission page lists these first:

1. Create an OSGeo User ID: https://www.osgeo.org/community/getting-started-osgeo/osgeo_userid/
   (If it takes more than 24 hours, email sysadmin@osgeo.org or ask in the
   Matrix room #sac:osgeo.org.)
2. Sign in once at https://www.osgeo.org/wp-admin with that User ID. Signing in
   creates the website profile you need before you can add content.
3. Join the incubator list (incubator@lists.osgeo.org) and request "project
   author" permission on the website. Mention your OSGeo User ID in the request
   so they can grant the role.
4. Then use **+ New > Project** to create the page. Save Draft often, the site
   logs you out after inactivity.
5. When the page is ready, ask the incubation committee to review and publish.

**Your to-do before submitting:**
- [ ] OSGeo User ID: **[FILL IN]**
- [ ] Signed in to wp-admin at least once
- [ ] Requested project-author permission (referencing the User ID above)
- [ ] Logo tile prepared (see section 2)

---

## 1. Incubation review checklist (what the committee verifies)

The committee checks three things. GratisGIS clears all three; the evidence
links below are what they will look for, so have them ready.

1. **Be geospatial.**
   Confirmed by the README and docs: a self-hosted platform for geospatial
   portals (maps, layers, forms, field data collection, dashboards, reports)
   built on PostGIS, MapLibre GL, vector tiles, and OGC API surfaces.
   Evidence: https://github.com/palavido-dev/gratis-gis#readme

2. **Free / open-source license, OSI-approved.**
   GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
   AGPL-3.0 is OSI-approved. Evidence:
   https://github.com/palavido-dev/gratis-gis/blob/main/LICENSE

3. **Welcomes participation and new contributors (clear contribution policy).**
   Evidence: CONTRIBUTING.md (branching, PR, commit, code-style, and review
   policy) plus a translations contributor guide.
   https://github.com/palavido-dev/gratis-gis/blob/main/CONTRIBUTING.md
   https://github.com/palavido-dev/gratis-gis/blob/main/CONTRIBUTING-TRANSLATIONS.md

---

## 2. Image assets you need to prepare (you said you'll make these)

**Required: logo tile.**
- Canvas exactly 740 x 412 px.
- Download the OSGeo backdrop `template_tile.png` and place your logo centered
  on it: https://www.osgeo.org/wp-content/uploads/template_tile.png
- When the form asks you to crop on upload, the 740 x 412 sizing means you lose
  nothing.

**Optional: framed screenshot.**
- Frame templates live at https://github.com/OSGeo/osgeo/tree/master/templates
  (frame-browser.png, frame-laptop.png, frame-mobile.png, frame-tablet.png).
- Put a portal screenshot inside the browser frame. A clean web-map authoring
  view or the items grid reads well at tile size.

---

## 3. Project form, field by field

These are the fields the form opens with. Paste the prepared values.

| Field | What to enter |
| --- | --- |
| **Title** | `GratisGIS` |
| **Project Type** | `None` (this is an initial listing; you are not yet a Community Project or full OSGeo Project) |
| **Logo** | Upload the 740 x 412 tile from section 2 |
| **Officer or representative** | Your OSGeo User ID: **[FILL IN]** |
| **Website** | `https://gratisgis.org` |
| **Source** | `https://github.com/palavido-dev/gratis-gis` |
| **Documentation** | `https://github.com/palavido-dev/gratis-gis/tree/main/docs` (swap to a hosted docs URL if you have one) |

The Title, Logo, and the introduction text (section 4) are combined into the
"tile" shown in the project list, so keep the intro tight.

---

## 4. Introduction / header text (used on the tile)

Keep this short; it shows on the project-list tile. Two length options.

**Short (one line, safest for the tile):**

> A self-hosted, open-source platform for geospatial portals: maps, layers,
> forms, field data collection, dashboards, and reports. Runs on your own
> infrastructure, on open formats throughout.

**Slightly longer (two sentences):**

> GratisGIS is a self-hosted, open-source platform for building a geospatial
> portal: publish maps and data layers, author forms, collect field data
> offline, and build dashboards and reports. It runs entirely on your own
> infrastructure using open formats (PostGIS, GeoJSON, vector tiles, OGC API),
> with no per-user licensing and no proprietary file formats.

---

## 5. Full description / content (the main body)

Paste this into the Content / description area. Plain prose, no commercial
product names.

> ### What it is
>
> GratisGIS is a self-hosted, open-source platform for standing up a complete
> geospatial portal on your own infrastructure. It covers the full lifecycle:
> publishing datasets and interactive web maps, authoring forms, collecting
> field data with offline support, and turning that data into dashboards and
> document reports. A small organization can run its own portal with no
> commercial licenses and no third-party cloud tenancy.
>
> ### Why it exists
>
> Operating a geospatial portal should not require six-figure annual licenses,
> named-user seats, or handing your data to someone else's cloud. GratisGIS has
> no per-user pricing (stand up one server and add as many users as you need),
> keeps your data on your hardware behind your firewall, and stores everything
> in a documented PostGIS schema with no opaque binary formats. If the project
> vanished tomorrow, your data is still queryable with `psql` and dumpable with
> `pg_dump`.
>
> ### What it does
>
> - **Portal:** users, groups, organizations, items, sharing, and fine-grained
>   access control, including per-share row, column, and geographic limits
>   enforced server-side.
> - **Web maps:** interactive map authoring backed by PostGIS data layers, with
>   vector-tile rendering for large datasets and import/export of common
>   web-map interchange formats.
> - **App builder:** a WYSIWYG, widget-based builder for configurable web apps.
> - **Data collection:** one web-and-mobile app with offline support that
>   combines survey authoring with field geometry capture.
> - **Reporting:** dashboards and document-style reports generated from
>   collected data.
> - **Tool and widget builder:** visual, node-graph authoring of custom
>   geospatial tools and app widgets, approachable for non-developers.
>
> External clients (QGIS, GDAL, scripting environments, editors) can connect to
> the portal data API with a personal API key, and share-level geographic
> limits are still enforced server-side.
>
> ### Standards and interoperability
>
> The project treats OGC API conformance as a guiding design goal. Wherever a
> new surface can be shaped to match an OGC API standard (Features, Tiles,
> Styles, Records) at low extra cost, the standard shape wins, so
> standards-aware tooling such as QGIS, GDAL, and OpenLayers can consume the
> portal without bespoke connectors. Open formats run end to end: GeoJSON,
> OGC API Features, vector tiles, CSW / ISO 19115 metadata, and DCAT catalog
> output.
>
> ### Status
>
> Active development, pre-v1. The portal, web-map authoring on PostGIS-backed
> data layers, vector-tile rendering, form authoring and submissions,
> dashboards, the app builder, the offline field app, derived-layer tools, and
> per-share access controls all work today, on top of an append-only
> observation-log data engine with geometry-aware authorization. Continuous
> integration runs on every push with roughly 400 backend tests.
>
> ### Try it
>
> A public test instance runs at https://gratisgis.org during the open feedback
> period. The landing page lists test credentials; tester changes reset every
> 24 hours to a clean golden state.

---

## 6. Built on (open-source stack, good to mention in the body or a sidebar)

Every load-bearing dependency is open-source. If the form has room, this list
shows good FOSS4G citizenship:

PostgreSQL + PostGIS, MapLibre GL, pg_tileserv and PostGIS `ST_AsMVT` vector
tiles, PMTiles, GDAL (raster/vector I/O), Terra Draw (drawing), h3-js (spatial
indexing), Keycloak (OIDC identity), Cedar (authorization), MinIO (S3-compatible
object storage), Caddy (HTTP edge), Node.js + NestJS (backend), Prisma (ORM and
migrations), Next.js + React (frontend), Tailwind CSS and shadcn/ui (UI),
Recharts (charts), and pnpm + Turborepo (monorepo tooling).

---

## 7. Topics / categories

OSGeo groups projects by category. GratisGIS spans a few, but pick the closest:

- **Primary: Web Mapping.** This is where portal and web-map platforms live
  (it is the largest category and the best fit).
- **Secondary, if multiple are allowed: Content Management Systems.** This is
  the category used for portal-style projects (for example GeoNode). GratisGIS
  is portal-first, so this fits its "publish and manage geospatial content"
  nature.

If only one topic is allowed, choose **Web Mapping**.

---

## 8. Quick-reference summary (the whole submission at a glance)

- **Title:** GratisGIS
- **Project Type:** None
- **License:** AGPL-3.0-or-later (OSI-approved)
- **Website:** https://gratisgis.org
- **Source:** https://github.com/palavido-dev/gratis-gis
- **Documentation:** https://github.com/palavido-dev/gratis-gis/tree/main/docs
- **Demo / test instance:** https://gratisgis.org
- **Officer / representative:** [YOUR OSGEO USER ID]
- **Primary topic:** Web Mapping
- **Logo tile:** 740 x 412 px, to prepare
- **Contribution policy:** CONTRIBUTING.md (satisfies the "welcomes
  contributors" checklist item)

---

### A couple of things worth deciding before you submit

- **Documentation URL.** Right now it points at the `docs/` folder on GitHub.
  If you would rather link a rendered docs site, swap it in section 3 and 8.
- **Naming.** All public copy here uses neutral framing and avoids naming any
  commercial product. If you ever want the FOSS4G-audience version that names
  the proprietary portal it parallels, that is a one-line add and you can make
  the call per surface.
