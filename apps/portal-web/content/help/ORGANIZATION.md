# Help organization

How the help catalog is shaped, and why.

## Principles

1. **One concept per page.** Buffer explains Buffer. Workflows that
   chain steps live on their own page.
2. **Task first on the landing.** The hub leads with "what are you
   trying to do?", then a full browse-by-area directory.
3. **Sidebar by product area, nested by job.** Top levels match how
   people think about the product (Items, Map editing, Analysis).
   Nested groups break long flat lists (Analysis → Proximity /
   Overlay / Geometry).
4. **URLs stay stable.** Regroup by changing the `category`
   frontmatter, not by moving files. Slugs come from the file path.
5. **UI steps get screenshots.** See `docs/help-screenshots.md` at the repo root.

## Category map

| Top level | Nested groups |
| --- | --- |
| Getting started | Coming from ArcGIS |
| Items | Maps & apps, Data, Field & forms, Organize, Advanced |
| Map editing | Symbology |
| Forms | (flat) |
| Web apps | Widgets |
| Print templates | (flat) |
| Analysis | Select & calculate, Proximity, Overlay, Geometry, Summarize, Generate |
| Admin | (flat) |
| Reference | (flat) |

Order is controlled in `apps/portal-web/src/lib/help/content.ts`
(`CATEGORY_ORDER`, `SUBCATEGORY_ORDER`, `CATEGORY_LABELS`).

## Authoring checklist

- Set `category` to the nested path that matches the table above.
- Set `order` within that group (lower = earlier).
- Keep `title` short: it is the sidebar label and the page heading.
- Set `seoTitle` to what the page is about in the words people search
  with, in about 60 characters. It is the browser tab and search
  result title, here and on gratisgis.org/help.
- Keep `summary` under about 160 characters. It is the search result
  description.
- Link to other help pages with the full path, `/help/<slug>`. The
  same files build gratisgis.org/help, so links have to work there
  too.
- If the page names a UI control, add a screenshot.
