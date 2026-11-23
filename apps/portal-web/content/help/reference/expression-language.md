---
id: reference-expression-language
title: Expression language
seoTitle: "Expression language: operators, functions, dates and lists"
summary: "The expression syntax for filters and calculated fields: values, operators, conditions, text, math, date, list and geometry functions, and how empty values behave."
category: reference
order: 20
complexity: intermediate
tags:
  - reference
  - expressions
  - syntax
  - dates
related:
  - map-editing-filters
  - analysis-filter
  - analysis-calculate
  - coming-from-arcgis-arcade
---

This page is the reference for the expressions you type into:

- The **Filter** step of a [derived layer](/help/items/derived-layer).
- The **Calculate field** step of a derived layer.
- **Calculate field** in a data layer's attribute table.

The same expression gives the same answer everywhere it runs: on the
server, in a preview in your browser, and in the field app with no
signal.

## Values

- **Numbers**: `1`, `3.14`, `-42`, `1.5e6`.
- **Text**: single or double quotes, `'open'` or `"open"`. A
  backslash escapes the next character: `'it\'s'`.
- **True and false**: `true`, `false`.
- **Empty**: `null`.
- **Lists**: `['oak', 'pine']`.
- **Comments**: `//` to the end of the line.

## Fields

Write a field as `{{status}}`. Names are case-sensitive; when the
case is wrong, the error message suggests the right spelling.

`$feature.status` and `$feature["status"]` also work, the same as in
Arcade. `$feature` on its own is the whole feature, which the
geometry functions take.

## Operators

| Kind | Operators | Example |
|---|---|---|
| Compare | `==` or `=`, `!=` or `<>`, `<`, `<=`, `>`, `>=` | `{{acres}} >= 5` |
| Logic | `AND` or `&&`, `OR` or `\|\|`, `NOT` or `!` | `{{status}} == 'open' AND NOT {{archived}}` |
| Math | `+`, `-`, `*`, `/`, `%` | `{{acres}} * 0.4047` |
| Join text | `+` when either side is text, or `~~` | `{{first}} + ' ' + {{last}}` |
| In a list | `IN`, `NOT IN` | `{{status}} IN ('open', 'pending')` |
| Range | `BETWEEN ... AND ...` | `{{acres}} BETWEEN 1 AND 5` |
| Pattern | `LIKE`, `ILIKE` (ignores capitals) | `{{name}} LIKE 'Oak%'` |
| Empty | `IS NULL`, `IS NOT NULL` | `{{owner}} IS NULL` |

- Words such as `AND`, `IN` and `CASE` can be any case.
- Comparisons are worked out first, then `NOT`, then `AND`, then
  `OR`. Use parentheses when in doubt.
- In `LIKE`, `%` matches any run of characters and `_` matches one.
  `\%` matches a real percent sign.
- `IN` also tests a multi-select field: `'oak' IN {{species}}`.

## Conditions

```
CASE
  WHEN {{acres}} > 10 THEN 'Large'
  WHEN {{acres}} > 1 THEN 'Medium'
  ELSE 'Small'
END
```

`CASE {{code}} WHEN 1 THEN 'Low' WHEN 2 THEN 'High' END` compares
one value with each `WHEN`. A `CASE` with no match and no `ELSE` is
empty.

The same choices are available as functions: `if`, `when`, `decode`
and `coalesce`. See the function list.

## Empty values

- `{{owner}} == null` and `{{owner}} IS NULL` are both true when the
  field is empty.
- Any other comparison with an empty value is false, so
  `{{owner}} == 'Baker'` is false for an empty owner and
  `{{owner}} != 'Baker'` is true.
- Math with an empty value is empty: `{{acres}} * 2` is empty when
  acres is.
- Joining text skips empty values: `'Owner: ' + {{owner}}` gives
  `Owner: ` when owner is empty.
- Dividing by zero, and anything that has no answer such as
  `sqrt(-1)`, gives an empty value instead of failing.
- Text in a number field that is not a number, such as `n/a`, reads
  as empty.

## Types

The expression is checked against the layer's fields before it
runs, and mistakes are reported with their position.

- **Numbers** take math and compare with numbers. To use a text
  field as a number, write `number({{lot}})`.
- **Text** compares as text, and joins with `+`, `~~` or `concat`.
- **Dates** compare as points in time, so a date with a time zone
  and one without compare correctly. Text such as `'2026-01-01'`
  compares with a date field directly. Dates take the date functions
  below instead of `+` and `-`.
- **Lists** (multi-select fields) compare with `==` against another
  list, or against one value meaning "exactly this one selection".
  Use `IN`, `contains`, `any_of` and `all_of` to test membership.

### Dates and time zones

Dates are stored in ISO 8601 form. A date with no time zone is read
as UTC. A date that falls exactly on midnight UTC shows as
`2026-11-23`; any other shows with its time, as `2026-11-23T14:30:00Z`.

`today()` is the date in the organization's time zone, which an
administrator sets under **Admin > Branding** (UTC until someone
does). Everything else works in UTC, so `hour()` of a time recorded
in California is the UTC hour.

## Functions

Function names are case-insensitive. Arcade names that mean the
same thing also work: `IIf`, `When`, `Decode`, `DefaultValue`,
`IsEmpty`, `Mid`, `Find`, `Concatenate`, `DateAdd`, `DateDiff`,
`Constrain`.

### Logic

| Function | What it does |
|---|---|
| `if(condition, then, else)` | `then` when the condition is true, otherwise `else`. Also `iif`. |
| `when(c1, v1, c2, v2, ..., default)` | The value after the first true condition. |
| `decode(value, m1, r1, m2, r2, ..., default)` | The result paired with the first match. |
| `coalesce(a, b, ...)` | The first value that is not empty. Also `defaultvalue`. |
| `is_empty(x)` | True for empty, empty text, or an empty list. Also `isempty`. |

### Text

| Function | What it does |
|---|---|
| `upper(t)`, `lower(t)` | Capitals or small letters. |
| `proper(t)` | Capitalizes each word: `proper('main st')` is `Main St`. |
| `trim(t)`, `ltrim(t)`, `rtrim(t)` | Removes spaces from both ends, the start, or the end. |
| `length(t)` | Number of characters. |
| `left(t, n)`, `right(t, n)` | The first or last n characters. |
| `substr(t, start, count)` | Part of the text. The first character is 1. `count` is optional. Also `mid`. |
| `index_of(t, search)` | Position of `search`, counting from 1, or 0 when it is not there. Also `find`. |
| `replace(t, find, with)` | Replaces every occurrence. |
| `concat(a, b, ...)` | Joins values, skipping empty ones. |
| `contains(t, search)` | True when `t` contains `search`, ignoring capitals. |
| `starts_with(t, s)`, `ends_with(t, s)` | True when `t` starts or ends with `s`. Capitals matter. |
| `pad_left(t, n, with)`, `pad_right(t, n, with)` | Pads to n characters: `pad_left({{lot}}, 4, '0')` gives `0042`. |
| `split_part(t, separator, n)` | The nth piece; a negative n counts from the end. |
| `format_number(x, decimals)` | `1,234.50` style text. |

### Math

| Function | What it does |
|---|---|
| `round(x, decimals)` | Rounds; halves round away from zero. `decimals` is optional and can be negative: `round(1234, -2)` is `1200`. |
| `floor(x)`, `ceil(x)`, `trunc(x)` | Round down, round up, drop decimals. |
| `abs(x)`, `sign(x)` | Without its sign; -1, 0 or 1. |
| `sqrt(x)`, `power(x, y)`, `exp(x)`, `ln(x)`, `log10(x)`, `pi()` | The usual. |
| `min(a, b, ...)`, `max(a, b, ...)` | Smallest or largest, skipping empty values. |
| `clamp(x, low, high)` | Keeps x between the limits. Also `constrain`. |

### Conversion

| Function | What it does |
|---|---|
| `number(x)` | Text to a number, or empty when it is not one. True is 1. |
| `text(x)` | Any value as text. |
| `to_date(t)` | Text to a date. `date('2026-07-04')` does the same. |
| `boolean(x)` | Reads yes/no, true/false, 1/0. |

### Dates

| Function | What it does |
|---|---|
| `today()` | Today's date, in the organization's time zone. |
| `now()` | The current date and time. |
| `date(year, month, day)` | A date, or empty when there is no such day. |
| `date_add(d, amount, unit)` | Moves a date. A negative amount goes back. Also `dateadd`. |
| `date_diff(later, earlier, unit)` | Time between two dates. Also `datediff`. |
| `start_of(d, unit)` | Start of the year, quarter, month, week (Monday), day, hour or minute. |
| `year`, `quarter`, `month`, `day`, `hour`, `minute`, `second` | One part of a date. Months are 1 to 12. |
| `weekday(d)` | Monday 1 to Sunday 7. |
| `day_of_year(d)`, `week(d)` | Day of the year; ISO week number. |
| `format_date(d, pattern)` | A date as text in your own pattern. |

Units are `'years'`, `'quarters'`, `'months'`, `'weeks'`, `'days'`,
`'hours'`, `'minutes'` and `'seconds'`. Singular forms work too.

- `date_add` with months, quarters or years takes whole numbers. Adding
  a month to January 31 gives the last day of February.
- `date_diff` in days and smaller units can have decimals. In months,
  quarters and years it counts only units that have fully passed.

Patterns for `format_date`:

| Pattern | Example |
|---|---|
| `YYYY`, `YY` | `2026`, `26` |
| `MMMM`, `MMM`, `MM`, `M` | `November`, `Nov`, `11`, `11` |
| `DD`, `D` | `03`, `3` |
| `dddd`, `ddd` | `Monday`, `Mon` |
| `HH`, `H`, `hh`, `h`, `A` | `14`, `14`, `02`, `2`, `PM` |
| `mm`, `ss` | minutes, seconds |
| `[text]` | text kept as written |

`format_date({{inspected}}, 'MMM D, YYYY')` gives `Nov 3, 2026`.

### Lists (multi-select fields)

| Function | What it does |
|---|---|
| `count(list)` | How many values. |
| `join(list, separator)` | One piece of text; `', '` by default. |
| `contains(list, value)` | True when the list has the value. |
| `any_of(list, v1, v2, ...)` | True when it has at least one of them. |
| `all_of(list, v1, v2, ...)` | True when it has all of them. |

### Geometry of the feature

| Function | What it does |
|---|---|
| `area($feature, unit)` | Area on the earth's surface. |
| `length($feature, unit)` | Length of a line, or perimeter of a polygon. |
| `x($feature)`, `y($feature)` | Longitude and latitude of a point, or of the center of a shape. |
| `geometry_type($feature)` | `Point`, `LineString`, `Polygon`, or a `Multi` form. |

Area units: `'square-meters'` (the default), `'square-kilometers'`,
`'square-feet'`, `'square-yards'`, `'square-miles'`, `'acres'`,
`'hectares'`. Length units: `'meters'` (the default),
`'kilometers'`, `'feet'`, `'us-survey-feet'`, `'yards'`, `'miles'`,
`'nautical-miles'`.

## Examples

- Hectares from acres: `round({{acres}} * 0.4047, 2)`
- Years since installation: `date_diff(today(), {{installed}}, 'years')`
- Due within 30 days: `{{due}} BETWEEN today() AND date_add(today(), 30, 'days')`
- Overdue inspections: `{{last_inspected}} < date_add(today(), -1, 'years') OR {{last_inspected}} IS NULL`
- Parcel label: `{{owner}} + ' (' + format_number(area($feature, 'acres'), 1) + ' ac)'`
- Size class: `CASE WHEN {{acres}} > 10 THEN 'Large' WHEN {{acres}} > 1 THEN 'Medium' ELSE 'Small' END`
- Zero-padded ID: `{{district}} + '-' + pad_left(text({{lot}}), 4, '0')`

## Not supported yet

- Variables, loops and user-defined functions.
- Regular expressions. Use `LIKE`, `contains`, `starts_with` and
  `ends_with`.

## Performance

A derived layer recomputes on every read, so a long chain of steps
over a large layer costs time on each request. Filter early in the
chain to keep later steps small.
