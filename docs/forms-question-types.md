# Form question types

## Why this exists

The form designer ships with 21 question types today. That covers the
basics for field data collection but leaves us short of what a respondent
expects from a paid survey product. The most visible gap is the matrix
question (a grid of rows-by-columns, one or many choices per row), which
is table stakes on every general-purpose survey platform and is the kind
of question the respondent sees on the very first survey they take.

This doc surveys what the leading paid products offer, marks where we
are vs. where we want to be, and proposes a phased plan to land the rest
without thrashing the schema. The intent is not to ship every type below;
it is to know, when a customer says "we use matrix questions in our
audit form," that we have a clear answer for them.

## Source comparison

The ten products we benchmark against, grouped by their natural audience:

  - General survey: Typeform, SurveyMonkey, Qualtrics, Google Forms,
    Microsoft Forms
  - Forms with workflow: Jotform, Formstack
  - Open / GIS-adjacent: KoBoToolbox (ODK), Survey123 (Esri)

Qualtrics is the gold standard for question type breadth. Typeform is
the leader on per-question UX polish. SurveyMonkey is the volume
leader. Survey123 and KoBo are the closest analogs to what GratisGIS
needs because they share the geometry, offline, and Field-mode story.

## What we have today (schema v1)

Twenty-one types in `packages/form-schema/src/index.ts`:

  - Text: `text`, `multiline`
  - Numeric: `number`, `integer`
  - Boolean: `boolean`
  - Choice: `select-one` (radio or dropdown), `select-many`
  - Date / time: `date`, `time`, `datetime`
  - Capture: `photo`, `signature`
  - Geometry: `geopoint`, `geotrace`, `geoshape`
  - Scales: `rating` (1-N stars), `slider`
  - Computation: `calculated`
  - Layout: `note`, `page`, `group` (with optional repeat)

Strengths: the JSON-only expression DSL, the `bindTo` link to data
layer columns, and the offline outbox give us a foundation that the
paid products generally do not have a direct equivalent for. The
geometry types and the repeating-group-as-related-table mapping are
ahead of every general-purpose survey product.

Gaps: no matrix family at all, no native ranking, no specialized text
types (email, URL, phone), no identity components (full-name parts,
address parts), no audio/video capture, no barcode scan, no NPS or
Likert as first-class, no image-choice. Those last two together are
what makes a survey feel "professional" out of the box.

## Comparison matrix

The presence-check below uses these glyphs:

  - "yes" the product ships this as a first-class question type
  - "lib" the product treats it as a library / form template, not a
    distinct question type, but the user can build it
  - no entry: not natively supported

|                              | Typeform | SurveyMonkey | Qualtrics | Google Forms | MS Forms | Jotform | Formstack | KoBo | Survey123 | GratisGIS |
| ---------------------------- | :------: | :----------: | :-------: | :----------: | :------: | :-----: | :-------: | :--: | :-------: | :-------: |
| Short text                   |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Long text                    |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Email                        |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    |      |    yes    |           |
| URL                          |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |    yes    |           |
| Phone                        |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |    yes    |           |
| Number                       |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Integer                      |          |              |    yes    |              |          |         |           | yes  |    yes    |    yes    |
| Currency                     |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |    yes    | (number)  |
| Percentage                   |          |     yes      |    yes    |              |          |         |           |      |           |           |
| Yes / No                     |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Single choice (radio)        |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Multiple choice              |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Dropdown                     |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    | (select)  |
| Image choice                 |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |           | yes  |           |           |
| Ranking (drag to reorder)    |   yes    |     yes      |    yes    |              |   yes    |   yes   |    yes    |      |    yes    |           |
| Likert                       |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    | (rating)  |
| Net Promoter Score (NPS)     |   yes    |     yes      |    yes    |              |   yes    |   yes   |           |      |    yes    |           |
| Slider                       |   yes    |     yes      |    yes    |     yes      |          |   yes   |    yes    | yes  |    yes    |    yes    |
| Star rating                  |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Semantic differential        |          |     yes      |    yes    |              |          |         |           |      |           |           |
| Matrix single (radio grid)   |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |           |
| Matrix multi (checkbox grid) |   yes    |     yes      |    yes    |              |   yes    |   yes   |    yes    | yes  |    yes    |           |
| Matrix dropdown              |          |     yes      |    yes    |              |          |   yes   |    yes    | yes  |    yes    |           |
| Matrix ranking               |          |     yes      |    yes    |              |          |   yes   |    yes    |      |           |           |
| Side-by-side matrix          |          |     yes      |    yes    |              |          |         |           |      |           |           |
| Constant sum                 |          |     yes      |    yes    |              |          |         |           |      |           |           |
| Heat map / hotspot           |          |     yes      |    yes    |              |          |   yes   |           |      |           |           |
| Date                         |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Time                         |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Date + time                  |          |     yes      |    yes    |              |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Date range                   |          |     yes      |    yes    |              |          |   yes   |    yes    |      |           |           |
| Duration                     |          |              |    yes    |              |          |         |           | yes  |           |           |
| Full name (multipart)        |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |           |           |
| Full address (multipart)     |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |    yes    |           |
| Photo                        |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Audio capture                |          |              |    yes    |              |          |   yes   |           | yes  |           |           |
| Video capture                |          |              |    yes    |              |          |   yes   |           | yes  |           |           |
| Generic file upload          |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    | (photo)   |
| Drawing / sketch             |          |              |    yes    |              |          |   yes   |    yes    |      |           |           |
| Signature                    |   yes    |     yes      |    yes    |              |          |   yes   |    yes    |      |    yes    |    yes    |
| Barcode / QR                 |          |              |           |              |          |         |           | yes  |    yes    |           |
| Geopoint                     |          |              |           |              |          |         |           | yes  |    yes    |    yes    |
| Geotrace (line)              |          |              |           |              |          |         |           | yes  |    yes    |    yes    |
| Geoshape (polygon)           |          |              |           |              |          |         |           | yes  |    yes    |    yes    |
| Pick from map / feature      |          |              |           |              |          |         |           |      |    yes    |           |
| Calculated                   |          |     yes      |    yes    |              |          |   yes   |    yes    | yes  |    yes    |    yes    |
| Hidden / pre-fill            |          |     yes      |    yes    |              |          |   yes   |    yes    | yes  |    yes    |           |
| Acknowledge / consent        |          |              |    yes    |              |          |   yes   |    yes    | yes  |    yes    |           |
| Color picker                 |          |              |           |              |          |   yes   |           |      |           |           |
| CAPTCHA                      |          |              |           |              |          |   yes   |    yes    |      |           |           |
| Page break                   |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |    yes    |
| Section header / image       |   yes    |     yes      |    yes    |     yes      |   yes    |   yes   |    yes    | yes  |    yes    |  (note)   |
| Repeating group              |          |              |   (lib)   |              |          |  (lib)  |   (lib)   | yes  |    yes    |    yes    |

The matrix family alone is six rows we are zero-for. That is the
single biggest credibility gap if a customer is comparing GratisGIS
side by side with a paid product.

## Proposed additions, by phase

The phases are sized so each one is a self-contained PR or two and
respects the schema's invariants (JSON-only, no eval, runtime parity
between server and browser).

### Phase 2a: Matrix family (the headline)

This is the biggest visible win and the closest thing to "you can't
take us seriously without this."

  1. `matrix-single` — rows of statements, columns of choices, one
     radio per row. The screenshot you pasted is exactly this.
  2. `matrix-multi` — same layout, checkboxes per row, multiple
     choices allowed.
  3. `matrix-dropdown` — same layout, but each cell is a per-row
     dropdown. Useful when columns are not parallel categories
     (e.g. a "current value" column and a "target value" column).
  4. `matrix-rating` — same layout, each cell is a star or numeric
     rating. Quick way to score a list of items on the same scale.

Schema sketch:

```ts
interface MatrixSingleQuestion extends QuestionBase {
  type: 'matrix-single';
  rows: { id: string; label: string }[];
  columns: { value: string; label: string }[];
  /** When set, the row source is dynamic (pick_list of row labels). */
  rowsPickListId?: string;
  /** Per-row required override; defaults to question-level required. */
  perRowRequired?: boolean;
}

// Response shape:  { [rowId]: 'columnValue' }
```

`matrix-multi` mirrors this with `Record<rowId, string[]>`.
`matrix-dropdown` lets each column carry its own `choices`.
`matrix-rating` borrows the existing `rating` config (max + shape).

Mobile: every matrix collapses to a stack of "row label, then the
options as a normal radio/checkbox/rating below it" on narrow
viewports. The desktop grid is a `display: grid` with `grid-template-columns`.

Layer mapping: a matrix can either flatten to one column per row
(`audit_q1`, `audit_q2`, ...) when bound to a flat layer, or to a
related child table when the layer has a `matrix_responses` related
table. Both are useful; the designer picks.

Validation: row-level required. The constraint expression DSL can
reference a row by `matrix.rowId.column` paths.

### Phase 2b: Ranking and side-by-side

  5. `ranking` — a list of items the respondent drags into preferred
     order. Captured as an ordered array of choice values.
  6. `matrix-rank` — a row-by-column matrix where each cell is a rank
     dropdown (1, 2, 3...) and each column can be used at most once
     per row. Less common; punt to 2c if implementation is fiddly.
  7. `matrix-side-by-side` — two matrices that share the row labels.
     Useful for "rate importance" + "rate satisfaction" in one block.

### Phase 2c: First-class scales

  8. `likert` — a single-row Likert (Strongly disagree → Strongly
     agree). Today this is achievable with `select-one` plus careful
     choice labeling, but having it as a type lets the runtime render
     the canonical horizontal scale and lets analytics treat it as
     ordinal. Default 5-point with optional 7-point and "neutral"
     middle option toggle.
  9. `nps` — Net Promoter Score, 0-10 buttons with the standard
     "Detractor / Passive / Promoter" coloring. Captured as integer.
 10. `semantic-differential` — bipolar adjective scale ("Cold ←→ Warm")
     across N points. Less common; safe to defer if Phase 2c is
     getting heavy.

### Phase 2d: Specialized text

These are all `text` today with a `pattern`, but giving them their
own type unlocks better mobile keyboards (`inputmode=email/tel/url`),
better validation messages, and better integration with the
calculated DSL (a future `is_email(...)` builtin).

 11. `email` — RFC 5322 lite validation; `inputmode=email`.
 12. `url` — must parse as a URL.
 13. `phone` — E.164 with country picker; `inputmode=tel`.
 14. `regex` — author supplies a custom pattern + error message. We
     already support `pattern` on `text`; the wrapper makes it more
     discoverable.

### Phase 2e: Identity components

These are technically composite types, but every general-purpose form
product treats them as one question because users always need them.

 15. `name` — first / middle / last / suffix in one block, captured as
     `{ first, middle?, last, suffix? }`. Required-on-each toggleable.
 16. `address` — street1 / street2 / city / region / postal / country
     in one block, captured as the same shape. The renderer can hide
     fields per-locale. When `bindTo` points at a layer with discrete
     address columns we map straight in; otherwise we land on a
     single `address_json` JSONB column or a denormalized set.

### Phase 2f: Capture (audio, video, drawing, barcode)

 17. `audio` — capture or upload, stored as `audio/*` attachment.
 18. `video` — capture or upload, stored as `video/*` attachment.
 19. `drawing` — freehand canvas. The output is an SVG + a PNG raster.
     Useful on Field forms for damage diagrams over a vehicle
     silhouette.
 20. `file` — generic file upload (today we conflate with `photo`).
 21. `barcode` — scans a 1D / 2D code via the device camera. KoBo and
     Survey123 both support this and it is a real differentiator for
     field workflows (asset tags, sample IDs).

Capacity, accept-types, and per-file-bytes mirror `photo`.

### Phase 2g: Specialized numeric / time

 22. `currency` — integer minor units + ISO 4217 code, rendered with
     locale-correct prefix and grouping. Today `number.currency`
     papers over this; making it a type catches sloppy bindings.
 23. `percentage` — number constrained 0..100 with a `%` suffix.
 24. `date-range` — pair of dates with a min-spread / max-spread
     constraint. Captured as `{ start, end }`.
 25. `duration` — hours / minutes captured as a single integer
     (seconds) for storage, rendered as a friendly hh:mm input.

### Phase 2h: Image-based questions

 26. `image-choice` — same semantics as `select-one` / `select-many`
     but each option is an image with a caption. Big mobile UX win.
 27. `image-hotspot` — the respondent clicks one or more points on a
     reference image. Captured as an array of `{ x, y }` (0..1).
     Common in "where does it hurt?" or "which part of the building?"
     type forms.

### Phase 2i: Display-only / utility

 28. `image-display` — embed an image as instructional content (no
     value captured). Today `note` only handles text.
 29. `divider` — a thin separator with optional caption.
 30. `acknowledge` — display long-form text with a required checkbox
     ("I have read and agree"). Captures the timestamp at which the
     user checked.
 31. `hidden` — value source via URL prefill or calculated; never
     rendered. Useful for campaign IDs, submitter UUIDs, signed
     tokens.
 32. `color` — color picker. Niche but trivial; mention for
     completeness.

### Phase 2j: GIS-specific extras

These are wins where we will out-feature any general-purpose product.

 33. `pick-feature` — respondent selects an existing feature from a
     bound layer (think "select the asset this incident is about").
     Captures the feature id; the runtime can then auto-fill any
     question whose `bindTo` references that feature's columns.
 34. `route` — between two pinned endpoints, capture a routed path
     (when a routing service is wired in). Otherwise falls back to
     `geotrace`.
 35. `area-buffer` — captures a center point + radius and stores the
     resulting circle as a polygon. Easier on field users than
     drawing a freehand polygon.

## Implementation considerations

**Wire format.** Every new type ships with three things: the schema
shape (above), a Postgres column-type mapping (`compatibleQuestionTypes`
for the Field runtime), and a JSON value shape for `Response[questionId]`.
The matrix family is the riskiest because the natural Response shape is
nested. We absorb that with `Record<rowId, value>` and treat each row
as a logical sub-question for the constraint DSL.

**Schema versioning.** Any change to a question's persisted shape bumps
`CURRENT_FORM_SCHEMA_VERSION`. Adding new question types in
`QUESTION_TYPES` is technically additive and could stay on v1, but I
would rather bump to v2 once we have the matrix family + identity
components landed and write a one-shot migrator that is ready for
when we add anything genuinely breaking.

**Expression DSL impact.** New `BUILTINS` we will want:

  - `is_email`, `is_url`, `is_phone`
  - `length` (alias of `len`)
  - `now_minus(days)`, `today_minus(days)` (date math)
  - `matrix_count_selected(refToMatrix)` (for cross-row required-if)
  - `pick_field(refToFeature, 'columnName')` (for `pick-feature`
    auto-fill)

These ship in both browser and server. Add them in the same PR that
adds the question type that needs them.

**Mobile + offline.** Every new type must render reasonably on a 320
px-wide viewport and persist to the IndexedDB outbox without extra
plumbing. The matrix collapse-to-stack rule, the `image-hotspot`
zoom-to-fit, and `audio/video` blob handling are the three that need
explicit attention.

**Export envelope.** The portable JSON envelope from #142 is structural,
not exhaustive. Every new question type rides through it for free as
long as the type discriminator is in `QUESTION_TYPES`. A future
GratisGIS that does not know about a newer type should refuse the
import with a clear error rather than silently dropping questions; we
already do this on schema-version mismatch.

**Designer palette.** With ~50 types post-Phase-2 the flat palette
becomes unusable. Group the palette into the categories above (Text,
Choice, Matrix, Scale, Date / time, Capture, Identity, Geometry,
Display, Advanced) and add a search box.

## Suggested rollout order

  - Slice 1 (1 PR): `matrix-single` and `matrix-multi`. The headline
    asks. Start the palette categorization at the same time so the
    new types have a home.
  - Slice 2 (1 PR): `ranking`, `matrix-dropdown`, `matrix-rating`.
    Same row-by-column rendering machinery.
  - Slice 3 (1 PR): `email`, `url`, `phone`, `regex`. Trivial but
    very visible.
  - Slice 4 (1 PR): `likert`, `nps`. Adds first-class scale UX without
    changing the response shape much.
  - Slice 5 (1 PR): `name`, `address`. Composite types; introduces the
    pattern we will reuse for `date-range`.
  - Slice 6 (1 PR): `image-choice`, `image-hotspot`, `image-display`.
    Image asset handling shared.
  - Slice 7 (1 PR): `audio`, `video`, `barcode`, `file`, `drawing`.
    Capture types share the attachment plumbing.
  - Slice 8 (1 PR): `acknowledge`, `hidden`, `divider`, `consent`.
    Utility types.
  - Slice 9 (1 PR): `pick-feature`, `area-buffer`, `route`. GIS-only,
    differentiator.
  - Slice 10 (1 PR): designer palette polish + search + categories.

That puts the matrix family in front of users in the first PR, which
is the right priority given the visible gap.

## Open questions

  - Do we want a "form template gallery" (NPS template, employee
    feedback template, audit checklist) the way SurveyMonkey does?
    Probably yes once the catalog is broad enough that "build it
    from scratch" is more work than "tweak a template."
  - Where do AI question authoring + AI answer summarization land
    relative to question-type breadth? My instinct: question types
    first (table stakes), then the AI on top of a richer schema.
  - For matrix questions specifically, do we want to support the
    Qualtrics "carry forward" pattern (rows of matrix B come from
    selected choices in select-many A)? That is a deep rabbit hole;
    not for the first slice.
