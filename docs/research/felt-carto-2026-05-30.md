# Felt and CARTO: competitive research for GratisGIS

Researched 2026-05-30 from marketing pages, docs, blog posts, customer
stories, Hacker News threads, and review-site verbatims (G2, Capterra,
TrustRadius, xpay). Reddit could not be crawled during this pass; HN +
G2 serve as the proxy for community sentiment and are over-represented
in direct quotes for that reason.

The aim is not "what do Felt and CARTO do." The aim is "what specific
features and design choices do small teams pay for and praise, and which
of those would be high-leverage for us to adopt."

---

## 1. Felt (felt.com)

### 1.1 What it actually is

Felt is a browser-native web GIS positioned as a collaborative,
warehouse-aware modernization of legacy GIS portals. Tagline on every
page: "A cloud-native GIS platform for everyone in your organization."
The canonical loop is: workspace → map → "upload anything"
(Shapefile / GeoTIFF / GPKG / GDB / KML / KMZ / CSV / Excel / Numbers,
plus WMS / WMTS) → style with strong defaults → invite collaborators or
generate a share link / iframe embed.

Concrete features:

- **Drag-and-drop upload that geocodes addresses, geomatches boundary
  names, parses geometry columns** — they market this as "no data
  wrangling required" and the marketing claim is backed by explicit
  geocoding + geomatching rows on the pricing page.
- **First-class distinction between data layers and "drawings"**
  (points, lines, polygons, annotations). Drawings are a separate
  collaboration primitive from data layers — same spirit as our
  `data_layer` vs map-annotation split.
- **Real-time collaboration with live cursors** ("the same map can
  have a GIS analyst styling layers while a field supervisor adds
  pins and a stakeholder leaves comments, all simultaneously"). This
  is the single feature they hammer on hardest.
- **Threaded comments** on maps, on every plan, with a separate
  "GUEST & PUBLIC COMMENT" surface for non-workspace participants.
- **Field application** (iOS, Android, tablet) with GPS capture,
  geotagged photos, survey forms, branching survey logic. Offline
  support is on the table but flagged as **beta** in their FAQ
  (marketed-as-shipped, qualified-as-beta in the same page).
- **Dashboards built on top of maps**, not as a separate item type.
  Widgets include H3 hex aggregation and time sliders.
- **Felt Style Language (FSL)** — their MapLibre-style spec. The MCP
  server uses it as the styling output format, so "no hand-authored
  JSON."
- **Felt AI + MCP server** (April 2026): one endpoint, 30 tools
  covering make-maps, ingest, write-SQL, spatial-analysis, styling,
  collaboration. Enterprise-only. Includes AI-generated custom HTML
  popups and natural-language SQL.
- **Live cloud-source connectors** (Enterprise only): Postgres /
  PostGIS, Snowflake, BigQuery, Databricks, Amazon S3 (COGs +
  GeoParquet), Microsoft SQL Server, plus STAC / WFS / WMTS. "Data
  never moves out of your warehouse, Felt only reads it."
- **One seat type** across the workspace ("No named users vs viewers
  vs contributors vs publishers"). 10 full seats included on
  Professional + unlimited free viewers; +$50/seat/month above 10.
  This positions directly against named-user licensing models.
- **Non-lock-in export at any time, any plan, including post-cancel**:
  Shapefile, GeoJSON, GeoPackage, GeoTIFF, CSV. Marketed as a
  competitive virtue.
- **Felt Server**: self-hosted runtime (1 instance on Pro, unlimited
  on Enterprise). Closed-source, sales-led. Not a self-hostable
  portal in the AGO sense.

### 1.2 What is *not* there (verified by absence on their surfaces)

- **No revision history / versioning** is advertised. AGO is also weak
  here, so this may be a shared gap rather than a Felt advantage.
- **No public item catalogue / portal directory**. Maps and "workspace
  libraries" are the unit, not items. AGO + GratisGIS have a
  public-facing `/items` notion that Felt does not.
- **No "routing" feature on Pro**. Isochrones / drive-time are
  Enterprise-only.
- **No PDF export specifically called out** — "image exports" only.
- **No custom projections** beyond Web Mercator are advertised; this
  was an explicit complaint in their 2022 launch HN thread that I
  could not confirm has been fixed.

### 1.3 Pricing reality

Felt has collapsed to **Personal (free hobbyist) + Professional + Enterprise**.
The legacy Starter/Pro/Team plans were retired in January 2025.

| Plan | Price | What you get | Key gates |
|---|---|---|---|
| Personal | Free forever | Unlimited maps, public sharing, basemaps only | **No data file uploads.** **No commercial use** — explicitly bans employer work, client projects, freelance, paid output. |
| Professional | Not publicly listed. Anchored by an Aug 2024 blog post at **$200/mo annual ($2,400/yr) for 10 seats**, +**$50/seat/month** beyond 10. Annual contracts only. | 10 full seats + unlimited free viewers, 25 GB/mo processing, 100k map views/mo, all upload formats, real-time collab, comments, Field App (offline beta), dashboards, 1 Felt Server, ArcGIS REST + Google Sheets import | Everything API/SDK/integration is gated above. |
| Enterprise | Sales quote only | Live warehouse connectors, advanced SQL, raster streaming, REST API + JS SDK, MCP, SSO/SAML, regional hosting, VPC, isochrones, auth-gated embeds, custom popups, domain capture, unlimited Felt Servers | Effectively the only tier with API access. |

Special: 30% off for verified US 501(c)(3); free for verified
students / classrooms / professors. No month-to-month, no public
Enterprise pricing. xpay's independent SaaS-pricing index rates Felt
**16/100** on pricing transparency in 2026 because every CTA goes to
sales.

The pricing floor for a real team is therefore **~$2,400/yr** plus
$600/seat/yr above 10. The cliff is sharp: there's no intermediate
"two-person consultancy" tier between Personal-free and 10-seat
Professional.

### 1.4 What paying users actually love

- **"Figma for maps."** Recurs verbatim across HN comments and product
  reviews. Specifically: live multi-cursor editing, low time-to-first-map
  for non-GIS users, shareable URL.
- **Visual polish + basemap quality** — Felt's tile rendering is
  consistently praised even by skeptics.
- **The non-GIS-analyst can self-serve.** Toole Design (transportation
  consultancy) cited "easier for non-QGIS planners to make their own
  maps" as the budget justification — i.e., they pay Felt to *reduce
  internal analyst dependency*, which is a more durable value
  proposition than any specific feature.
- **Clean GeoJSON in / GeoJSON out for collaboration with external
  stakeholders.** Alta Planning used Felt for community design
  charrettes and exported the feedback as GeoJSON.

### 1.5 What they complain about

- **"Child's toy compared to ArcGIS"** — repeated HN sentiment in
  2022, somewhat softened in 2026 but still present. People who hit
  it: drone / orthophoto users wanting custom tile pipelines, anyone
  who needs custom projections, anyone with >10 M features.
- **Free tier got worse.** Personal can no longer upload files at
  all. The "I'm one dude, not a business" gap is back.
- **Performance with large datasets**, slow processing of complex maps.
- **Account wall on the demo** — "why can't I just draw without an
  account."
- **OSM attribution is sloppy** on the mobile view (ODbL concern flagged
  by OSM contributors).
- **AI / Lightning is bolted-on + Enterprise-only**, which the HN crowd
  reads as "we don't trust this is the real product."

### 1.6 Positioning

Felt explicitly:

- Welcomes / partners with QGIS ("the first flagship sustaining member"
  of QGIS in March 2023).
- Goes after ArcGIS structurally without naming them ("forty years of
  walled-off GIS just ended").
- Markets explicit AGO import via Feature/Map/Image Server URLs and
  encourages a "keep both during a transition" message rather than
  forklift.
- Positions against Mapbox on pricing predictability ("subscription
  pricing easier to understand than Mapbox's usage-based PAYG").

---

## 2. CARTO (carto.com)

### 2.1 What it actually is

The active product is the **post-2021 "CARTO 3" stack**. The legacy
CARTO Engine / Builder / Mobile (CartoDB era) is end-of-life. The
current module set is:

- **CARTO Workbench**: the IDE. Contains Maps, Workflows, Data Explorer,
  Connections, SQL Console.
- **CARTO Builder**: the dashboard / web map builder, inside Workbench.
- **CARTO Workflows**: visual no-code analysis graph. 100+ pre-built
  nodes (spatial joins, filters, isolines, clustering, H3 / Quadbin /
  S2 indexing, length/area, URL ingest, email export, tileset gen).
  Directed graph, not just linear pipelines. Compiles to native
  warehouse SQL and runs in-warehouse.
- **Analytics Toolbox**: per-warehouse UDF + stored-procedure bundles
  for BigQuery / Snowflake / Databricks / Redshift / Postgres / Oracle.
  Workflows generates the right dialect when it compiles a graph.
- **CARTO AI Agents** (GA 2025): conversational layer on top of maps
  and workflows, with multi-step execution, an Agent Configuration
  Assistant that generates the agent config from natural language,
  and domain-specific agents (Site Selection, etc.).
- **CARTO MCP Server** (2025): exposes a customer's Workflows as
  MCP tools any agent can call.
- **CARTO Data Warehouse**: optional managed BigQuery for customers
  who don't have their own warehouse.

### 2.2 Where the non-SQL cliff actually is

This is the thing that matters and the section I want to be most
concrete on.

**Accessible without SQL:**

- The full **Workflows** surface. Buffer, intersect, spatial join,
  point-in-polygon, isoline, clustering, H3 aggregation, attribute
  calculator are all drag-and-drop nodes. Workflows is the
  legitimately-impressive part of CARTO.
- **Builder dashboards** as long as the data is already shaped and
  the question can be answered by the seven canned widgets (Formula,
  Category, Pie, Histogram, Range, Time Series, Table) against
  existing columns.

**Cliff appears at:**

- **Warehouse setup**. The product *assumes you already have* a
  Snowflake / BigQuery / Databricks / Redshift / Postgres / Oracle
  connection. A casual user with a shapefile and no warehouse cannot
  self-serve.
- **Custom Builder widgets.** The moment you want a widget tied to a
  query that isn't a one-to-one read of a table column, the only
  escape is hand-written **SQL Parameters** (placeholders like
  `{{date_from}}`). That's the classic "analyst preps, business
  users consume" handoff.
- **App building.** Requires the SDK, in practice requires
  professional services. The loudest Felt criticism that lands.
- **Raster is thin.** Some file types only; complex rasters need an
  external reprojection pipeline.
- **No mobile / field app at all.** No Survey123, no Field Maps, no
  Felt Field App equivalent.
- **Cost visibility.** Every map interaction triggers a charge to
  the customer's warehouse. CARTO charges for the platform; warehouse
  compute is a separate bill that hits the customer after the fact.
  Felt's CARTO-alternatives page leans on this point, and it is a
  real architectural difference rather than a marketing line.

### 2.3 Pricing reality

CARTO is **deliberately number-free**. Every visible tier on
carto.com/pricing is "Get a quote":

| Plan | Pricing | Notes |
|---|---|---|
| Enterprise | Contact vendor | "Basic" usage quota, single business unit, cloud-only, limited API access |
| Strategic | Contact vendor | Multi-departmental, expanded quota, self-hosted optional, unlimited API |
| Custom | Contact vendor | Large enterprise, high-volume quota, self-hosted included |

- **No free tier.** 14-day trial only. Production use during the
  trial is explicitly prohibited; trials cannot be extended.
- **G2 "Perceived Cost" indicator: maximum ($$$$$).**
- **A leaked "Small" plan reference** showed 3 editors / 15 viewers /
  180,000 usage units per year somewhere; not on current public page,
  possibly retired.
- Industry context puts a typical Enterprise contract in the
  **$25k-$100k/yr** band for a single business unit, with Strategic /
  Custom in the low-to-mid six figures. CARTO declines to confirm.

The most consistent public complaint pattern is **pricing opacity +
double-billing surprise + sales friction**. The strongest single
public statement: an HN comment in July 2025 calling CARTO's sales
"awful" and pricing "wildly expensive and opaque." G2 verified
reviewers frame it structurally: "they've removed any pricing tier
that could be remotely affordable to an individual, and have left
only those pricing tiers that enterprises can afford."

### 2.4 Who actually buys CARTO

Look at the customer-story logo wall and the conclusion is obvious:
**Fortune 500 / large enterprise / warehouse-already-deployed**.
Vodafone, T-Mobile, BT, Coca-Cola, AXA, JLL, Bain, Telefónica,
Clear Channel, Deliveroo, Booking, Havas, Renault, NHL, NYC.
Industry verticals: Telecom, Insurance, Logistics, Real Estate,
Financial Services, Retail, Mobility — the segments where there's
already a warehouse contract and a data team that thinks in SQL.
Featured solutions: Network Deployment, Catastrophe Modeling,
Fraud Detection, Site Selection, Geomarketing, Territory Planning.

CARTO has **effectively exited the small-team market**. G2 review
consensus for small businesses: "reviewers suggest open-source
alternatives like QGIS or Kepler.gl might be better options."

### 2.5 What paying users actually love

- **Warehouse-native + SQL power.** "The ease with which I can access
  my big-data warehouse has alleviated much of the headache that
  typically comes with data hosting."
- **Workflows graph + 100+ nodes** is the headline product
  achievement. It's genuinely good.
- **Deck.gl engineering pedigree.** Even competitors acknowledge it.

### 2.6 What they complain about

- **Pricing opacity + double-billing + sales friction** — discussed
  above.
- **Builder is starved for investment.** "Carto Builder should be a
  key product in their offering and development efforts seem to be
  towards other products for the last few years." (G2.)
- **Performance at scale.** Jenks classification timeouts on larger
  polygon datasets, can't vacuum large tables.
- **Steep commercial jump from non-commercial license.**
- **Recent UI redesigns made entry-level navigation harder** even
  while expanding power-user features.

---

## 3. Cross-comparison

| Dimension | Felt | CARTO |
|---|---|---|
| Target buyer | 1-100 person creative + planning teams replacing ArcGIS portals | Fortune 500 data teams with existing warehouses |
| Onboarding | Same-day self-serve trial → 10-seat purchase | Sales-led → assisted trial → annual contract |
| Primary differentiator | Real-time multi-cursor + AI/MCP + 10-seat flat pricing | Warehouse-native execution + Workflows graph + AI Agents |
| Pricing transparency | Tier names + included quotas public, dollars semi-public via blog/help center | Tier names only, every dollar is sales-quote |
| Cost surprise risk | Predictable (Felt pre-tiles, no warehouse pass-through) | High (every interaction hits customer's warehouse) |
| Skill bar | No-code or SQL | SQL fluency required for non-trivial work |
| Raster + imagery | Native COGs, STAC, raster streaming on Enterprise | Limited file-type support; external reprojection needed |
| Field / mobile | First-class Field App, offline in beta | None |
| Self-hosted | Felt Server (closed-source binary) on Pro/Enterprise | Self-hosted only on Strategic + Custom tiers |
| AI / MCP | Felt AI + MCP server, Enterprise-gated | AI Agents + MCP server, all Enterprise-tier in practice |
| Public item catalogue | None | None |
| Versioning / revision history | Not advertised | Not advertised |

### 3.1 Where each wins for small-team buyers

- **Felt wins** when the team's pain is "we want a non-GIS person to
  publish a useful map this afternoon" or "we want real-time
  collaboration on a shared map with stakeholders."
- **CARTO wins** when the team already has Snowflake/BigQuery and an
  analyst who thinks in SQL, and they want spatial primitives that
  compile to native warehouse SQL.
- **Neither wins** for the truly small (1-3 person) team because of
  the pricing cliff. CARTO is gone above the small-business water-
  line; Felt's $2,400/yr floor and "no commercial use on free"
  rule excludes the two-person consultancy.
- **Migration patterns observed** (from HN + G2):
  - CARTO → Dekart / kepler.gl / DIY PostGIS + deck.gl, driven by
    pricing opacity and warehouse-cost surprise.
  - CARTO → ArcGIS Online when teams hit the SQL ceiling and need
    deeper analysis.
  - Felt → Mapbox Studio + React when pixel control or large datasets
    are needed.
  - Felt → QGIS when the user concludes Felt isn't "real GIS."

### 3.2 Common gaps that neither vendor closes

- **Versioning / revision history** on maps and layers.
- **Public-facing portal directory** of items in the AGO sense.
- **Self-host that's actually self-host** (open binary or source,
  not just a CARTO Strategic+ option or a closed Felt Server license).
- **A pricing tier for the 2-person consultancy** that's between free
  and $200/mo for 10 seats.
- **PDF export of layout-style print maps** that respect legend +
  scale-bar conventions.

These are gaps GratisGIS can credibly close.

---

## 4. GratisGIS-actionable punch list

Opinionated, concrete, ranked roughly by leverage. Each takeaway names
a feature or UX pattern, says where in our stack it would land, and
estimates the cost-to-impact tradeoff.

### Tier A — high-leverage, plausibly within a quarter

1. **Live-cursor multi-user editing on maps.** This is Felt's
   single hardest differentiator and it's the one feature that
   small teams across both products praise unprompted. We have the
   y-doc-able state (map JSON, layer order, viewport, selection)
   sitting in our existing item document. The implementation cost
   is the Yjs/CRDT + WebSocket transport tier, not the UI. **High
   buyer-perception lift per engineer-week**. Worth a dedicated
   spike to prototype on a single map editor. Even partial
   implementation (presence + cursors without conflict-free edits)
   would close ~70% of the perception gap.

2. **Threaded comments on maps + on individual features.**
   Sub-component of #1 and dramatically easier than full live-edit.
   Could ship as a Phase 1 of the collaboration story before
   live-cursors are ready. Felt explicitly markets this on every
   plan and it's the single most "Figma-coded" thing about their
   product.

3. **A no-code "Workflows"-style visual graph for spatial
   analysis.** We already have a tools/recipe system with a visual
   builder for OSM relational queries. The Workflows model is
   strictly more general: nodes for buffer / intersect / clip /
   spatial join / point-in-polygon / H3 aggregate / centroid /
   convex hull / dissolve / unary union, with arbitrary
   directed-graph wiring rather than our current linear-recipe
   shape. **Generalize the existing recipe runner** to be a DAG
   instead of a list. This is the CARTO feature non-SQL users
   actually love, and the lift on top of what we already have is
   smaller than building it greenfield.

4. **Per-warehouse "live read" connector for one warehouse first
   (PostGIS).** Felt and CARTO both gate this to Enterprise; we
   ship it on day one. PostGIS as a `data_layer` source that we
   read without copying. This is mostly a discovery-and-permission
   layer on top of the existing arcgis_service pattern. Snowflake
   and BigQuery come later; PostGIS-as-source unlocks the
   self-hosters with an existing PostGIS warehouse — exactly our
   buyer.

5. **Friendly print/PDF export with legend + scale + title.**
   Mentioned by users of both products and shipped by neither
   well. QGIS Print Layout is the bar. A scaled-down version
   (template + layer-list + scale-bar + legend + north arrow +
   title) for our `map` items would close a real gap. Buyers ask
   for this constantly.

### Tier B — high-leverage, but bigger lifts

6. **A no-config drag-and-drop "Upload Anything" ingest path** that
   geocodes addresses, geomatches boundary names, and auto-detects
   geometry columns the way Felt advertises. We already accept the
   formats. The gap is the post-upload smart-detection layer:
   "this column looks like a US ZIP code, want me to geomatch it
   to ZCTA polygons?" / "this column looks like a street address,
   want me to geocode it?" Probably a separate ingest service that
   uses Nominatim (already running optionally) for geocoding plus a
   small set of vendored boundary lookups (US states, US counties,
   US ZIPs, country ISO codes) for geomatching.

7. **A first-class "drawings" primitive distinct from data layers**
   on maps, exactly as Felt models it. Points, lines, polygons,
   annotations live on the map as a collaboration surface, not as
   a data_layer. Our editor pane is already the right home for this
   (per prior pane redesign). Tight scope: one new column on
   `map.data_json` (`drawings: GeoJSON FC`) + a render layer + the
   editor UI + share-link/embed considerations. The win is letting
   a stakeholder "draw a circle on the parcel map and add a
   comment" without polluting the actual parcels layer.

8. **MCP server.** Felt and CARTO both shipped one in 2025-2026.
   For GratisGIS this is mostly a thin wrapper that exposes our
   existing tool-runner and recipe APIs as MCP tools. Doable
   relatively cheaply because the engine work is done. Positioning
   value is high: MCP access ships on every install, with no plan
   gating. Genuinely small lift.

### Tier C — lower priority but worth flagging

9. **Single seat type, no named-user licensing.** This is Felt's
   marketing move, not a feature. We already don't have seat tiers
   because we don't have paid tiers. Worth deliberately preserving
   this — when we add a hosted edition, keep the seat model flat.
   No `viewer` vs `editor` vs `publisher` tiers.

10. **Non-lock-in exports as a marketing position.** We already ship
    GeoPackage / Shapefile / GeoJSON export. Felt makes a marketing
    point of "exports available on any plan, including after
    cancellation." Worth mirroring as positioning — a `/items/:id/
    export` endpoint that's always on, regardless of permissions
    expiring, plus a docs page making the no-lock-in commitment
    explicit.

11. **Routing.** Still deferred (#154). Worth revisiting if the
    OpenRouteService self-host footprint we sketched earlier turns
    out to be cheaper than initially thought. Felt isochrones are
    Enterprise-only and CARTO does isolines via Workflows; an
    isochrone starter template available on every install would be
    a clear differentiator.

### Anti-takeaways: things to deliberately *not* copy

- **AI Agents that generate dashboards / workflows from a prompt.**
  Both Felt and CARTO are leaning hard here. The HN crowd
  consistently calls the results "bolted on." Don't ship this until
  the no-code Workflows DAG (#3) is solid; AI on top of a weak
  primitive doesn't read as compelling.
- **Felt-style "single map item is also the dashboard."** Felt
  collapses these for product simplicity. We deliberately have
  `dashboard` as its own item type so a dashboard can mix multiple
  maps + non-map widgets. Don't collapse.
- **CARTO-style pricing opacity.** When we add a hosted edition,
  publish prices. Pricing transparency is itself a differentiator.

---

## 5. Positioning notes

The positioning and outreach notes that used to live in this section
were moved out of the public tree.

---

## Sources

### Felt — product + pricing
- [felt.com homepage](https://felt.com/)
- [felt.com/pricing](https://felt.com/pricing)
- [felt.com/platform/web-gis](https://felt.com/platform/web-gis)
- [felt.com/platform/felt-ai](https://felt.com/platform/felt-ai)
- [felt.com/blog/introducing-felt-mcp-server](https://felt.com/blog/introducing-felt-mcp-server)
- [felt.com/blog/introducing-the-new-team-plan](https://felt.com/blog/introducing-the-new-team-plan)
- [felt.com/blog/qgis-vs-arcgis](https://felt.com/blog/qgis-vs-arcgis)
- [felt.com/blog/mapbox-alternatives](https://felt.com/blog/mapbox-alternatives)
- [felt.com/customers/toole-design-group](https://felt.com/customers/toole-design-group)
- [help.felt.com — Billing](https://help.felt.com/administration/billing)
- [felt.com/carto-alternatives](https://felt.com/carto-alternatives)

### CARTO — product + pricing
- [docs.carto.com — CARTO in a nutshell](https://docs.carto.com/getting-started/carto-in-a-nutshell)
- [carto.com/builder](https://carto.com/builder/)
- [carto.com/blog — What's New Q1 2025](https://carto.com/blog/whats-new-in-carto-q1-2025)
- [docs.carto.com — Workflows](https://docs.carto.com/carto-user-manual/workflows)
- [carto.com/blog — Workflows beta](https://carto.com/blog/no-code-workflows-beta/)
- [carto.com/blog — Workflows Templates](https://carto.com/blog/workflows-templates-pre-built-spatial-analysis)
- [docs.carto.com — Widgets](https://docs.carto.com/carto-user-manual/maps/widgets)
- [academy.carto.com — Widgets and SQL Parameters](https://academy.carto.com/building-interactive-maps/widgets-and-sql-parameters)
- [docs.carto.com — Analytics Toolbox Overview](https://docs.carto.com/data-and-analysis/analytics-toolbox-overview)
- [github.com/CartoDB/analytics-toolbox-core](https://github.com/CartoDB/analytics-toolbox-core)
- [carto.com/ai-agents](https://carto.com/ai-agents/)
- [carto.com/blog — Agentic GIS](https://carto.com/blog/agentic-gis-bringing-ai-driven-spatial-analysis-to-everyone)
- [carto.com/blog — MCP server](https://carto.com/blog/carto-mcp-server-turn-your-ai-agents-into-geospatial-experts/)
- [carto.com/pricing](https://carto.com/pricing/)
- [carto.com/customer-stories](https://carto.com/customer-stories/)
- [docs.carto.com — FAQs](https://docs.carto.com/faqs)

### User sentiment + review aggregators
- [HN 34972587 — Felt team plan (Feb 2023)](https://news.ycombinator.com/item?id=34972587)
- [HN 31982959 — Felt 1.0 (Jun 2022)](https://news.ycombinator.com/item?id=31982959)
- [HN 46290875 — Felt Lightning (Dec 2025)](https://news.ycombinator.com/item?id=46290875)
- [HN 44465415 — Dekart vs CARTO (Jul 2025)](https://news.ycombinator.com/item?id=44465415)
- [G2 — Felt reviews](https://www.g2.com/products/felt/reviews)
- [G2 — CARTO reviews](https://www.g2.com/products/carto/reviews)
- [G2 — CARTO pricing](https://www.g2.com/products/carto/pricing)
- [Capterra — CARTO pricing](https://www.capterra.com/p/140192/CartoDB/pricing/)
- [Capterra — CARTO reviews](https://www.capterra.com/p/140192/CartoDB/reviews/)
- [TrustRadius — CARTO pricing](https://www.trustradius.com/products/carto/pricing)
- [xpay — Felt SaaS pricing audit (2026-05-06)](https://www.xpay.sh/saas-pricing/felt-software/)
- [Atlas — top CARTO alternatives 2026](https://atlas.co/blog/top-10-carto-alternatives-2026/)
- [Atlas — top Mapbox alternatives 2026](https://atlas.co/blog/top-10-mapbox-alternatives-2026/)
- [lowcode.agency — CARTO Builder review](https://www.lowcode.agency/nocode-tools/carto-builder)
- [Foursquare Studio](https://foursquare.com/products/studio/)
