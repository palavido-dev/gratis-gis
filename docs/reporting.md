# Reporting (report_template items)

A report template is a document filled once per feature of a data
layer and printed to PDF. Forms write their submissions into a paired
data layer, so a template on that layer reports on form submissions
(the Survey123 "feature report" job).

The plain-text PDF receipt for one submission
(`GET /api/forms/:id/submissions/:submissionId/pdf`) still exists and
is unrelated.

## Data shape

`packages/shared-types/src/report-template.ts`:

```ts
{
  version: 1,
  sources: [{ itemId: '<data layer>', layerKey: '<sublayer>' }],
  body: '# Inspection {{site_id}} ...',
  page: { size: 'letter' | 'legal' | 'a4' | 'a3' | 'tabloid', orientation: 'portrait' | 'landscape' },
  fileName?: 'Inspections',
}
```

`normalizeReportTemplate` checks it on every create and update.
`sources` is an array so the dependency extractor reads it the same
way as other items; it holds at most one entry.

## Template body

Plain text with a Markdown subset (headings, bold, italic, lists,
tables, rules, `\pagebreak`) and placeholders:

- `{{field}}`: the field's value. Pick list fields show the label.
- `{{= expression }}`: anything the expression language does,
  including `related()`, `layer()`, `nearest()` and date formatting.
- `{{photos}}`: the feature's image attachments.

Everything is escaped. The template cannot add raw HTML, and values
cannot become Markdown, because placeholders are swapped for markers
before the Markdown is rendered and filled in afterwards.

## Rendering

- `POST /api/items/:id/report` with `{ featureIds }` (up to 100)
  returns one PDF with a section per feature.
- `POST /api/reports/preview` with `{ sourceItemId, layerKey, body,
featureId? }` returns HTML for one feature, for the editor.

Values come from `ExpressionsService.evaluate` under the requester's
own access, so share limits (own rows, geographic limits) apply.
Photos need download permission on the layer and are inlined as
resized JPEG data URIs. Chromium (the `CHROMIUM_WS_ENDPOINTS` used by
print templates) prints the page with JavaScript off and every
network request refused.

## Not built

- Tables of related records (repeats). An expression can count or
  summarize related rows (`count(related('visits'))`,
  `join(...)`), but there is no row-by-row table yet.
- A map image of the feature.
- Word (.docx) output and Word templates.
- Scheduled report emails.
