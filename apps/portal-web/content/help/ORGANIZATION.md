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
5. **UI steps get screenshots.** See `SCREENSHOTS.md`.

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
- Keep `title` + `summary` search-friendly.
- If the page names a UI control, add a screenshot.
