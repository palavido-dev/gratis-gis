---
id: items-report-template
title: Report template
seoTitle: 'Report templates: PDF reports for each feature or form submission'
summary: A document filled once per feature or form submission, such as an inspection report, written with field and expression placeholders and downloaded as PDF.
category: items/maps-and-apps
order: 70
complexity: intermediate
tags:
  - report-template
  - item-type
  - reporting
  - pdf
related:
  - items-print-template
  - items-data-layer
  - items-form
  - reference-expression-language
---

A **report template** is a document filled once for each feature of a
data layer and downloaded as a PDF. Forms store their answers in a
data layer, so a report template on that layer makes one report per
form submission, like a Survey123 feature report.

## Make a template

1. **New item**, **Report template**, and give it a title.
2. Pick the **layer to report on**. For a form, pick the data layer
   the form writes to. The template starts with a table of every
   field and the photos.
3. Edit the template, then **Preview** to see it filled for a
   feature. **Save** when it looks right.

## Writing the template

The template is text with a little Markdown:

| Write                   | Get                    |
| ----------------------- | ---------------------- |
| `# Title`, `## Section` | Headings               |
| `**bold**`, `*italic*`  | Bold and italic        |
| `- item` or `1. item`   | Lists                  |
| A pipe table with a `   | ---                    | --- | ` line | A table |
| `---`                   | A line across the page |
| `\pagebreak`            | A new page             |

And placeholders:

| Placeholder                                         | Shows                                                      |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `{{status}}`                                        | The field's value. Fields with a pick list show the label. |
| `{{= format_date({{inspected}}, 'MMMM D, YYYY') }}` | Any [expression](/help/reference/expression-language)      |
| `{{= count(related('visits')) }}`                   | Related records, other layers and nearby features work too |
| `{{photos}}`                                        | The feature's photo attachments                            |

Click a field name under the template to insert it. Anything the
template cannot fill (a misspelled field, an expression with an
error) shows as a note under the preview and is left blank in the
report.

## Download reports

Under **Download reports**, tick the features you want (up to 100 at a
time, newest first; search to narrow the list) and click **Download
PDF**. You get one PDF with each feature on its own page, numbered
"Page X of Y".

Each report shows what you can see in the layer. Share limits apply,
and photos need download permission on the layer.

## Limits

- No tables of related records yet. Use an expression to count or
  list them.
- No map image of the feature, no Word output, no scheduled emails.
- PDF output needs the same Chromium service as print templates. If
  it is not set up, the download says so.

## See also

- [Print template](/help/items/print-template): a page layout for the
  Print tool in a web app.
- [Expression language](/help/reference/expression-language)
