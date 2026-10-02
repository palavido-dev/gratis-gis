# Reporting (report_template items)

Status: not built. The create picker does not offer
`report_template`. KPI and operations dashboards ship as web-app
layouts, and print templates are the shipped paper layout for the
Print tool. This page is the design for the document-report item
that does not exist yet. For what ships today, see the Status
section in [README.md](../README.md).

Reporting would turn a form submission (or a feature row, or an
aggregate query) into a shareable document: a PDF, a Word doc, or
an HTML page.

## Template shape

A report_template stores a layout plus a data binding. The layout is a
structured document (sections, headings, placeholders, widgets). The
binding says where the data comes from and how to map source fields
into placeholders.

Proposed data shape:

```ts
{
  version: 1,
  source: {
    kind: 'form' | 'data-layer' | 'query',
    itemId: string,
  },
  sections: Section[],
}

type Section =
  | { type: 'text', markdown: string }
  | { type: 'field', sourceField: string, label?: string, format?: string }
  | { type: 'image', sourceField: string } // photo attachments
  | { type: 'map', mapItemId: string, highlightFeature: true }
  | { type: 'signature', sourceField: string }
```

## Rendering

Server-side. HTML is the canonical render; PDF is `html → wkhtmltopdf
or puppeteer-chrome` and Word is `html → pandoc` or a templated .docx.
One pipeline keeps fonts, margins, and page breaks consistent across
formats.

Template authoring happens in portal-web; a shared `@gratis-gis/report-
render` package handles the actual render so the backend (and later
the field app's "export this submission" button) can use the same
logic.

## Access

A report template inherits its sharing model from the item layer. A
rendered instance is a file (download link, retention rules TBD).
Bulk render (all submissions for a form, one report each) is a
scheduled task that produces a zipped archive.

## Not yet decided

- Whether reports are first-class items on their own (a report_run
  item for each rendered instance) or ephemeral. First-class makes
  sharing easier; ephemeral keeps the catalog tidy.
- Localization. Templates want `{{fields.height | format: 'm'}}` in
  one language and `{{fields.altura | format: 'm'}}` in another.
  Cleanest: store labels per-locale, pick based on requester's
  Accept-Language.

## Status

Not implemented. See `coming-soon.tsx` for the placeholder.
