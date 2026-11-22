---
id: forms-conditional-logic
title: Conditional logic
seoTitle: "Form conditional logic: show or hide questions"
summary: Show or hide form questions based on the answers to earlier questions. Same expression dialect as filters and calculate steps.
category: forms
order: 30
complexity: intermediate
tags:
  - forms
  - conditional
  - logic
related:
  - forms-form-designer
  - forms-question-types
  - analysis-filter
---

A form **conditional** is a Boolean expression on the question
editor's **Visibility** field. The question renders to the
respondent only when the expression is true. Empty expression =
always visible.

## Where to set it

Click the question in the form designer; the right panel has a
**Conditional visibility** input. Either:

- **Build it visually**: pick a field, an operator, a value.
 Combine with AND / OR.
- **Type the expression directly**: same SQL-like dialect as
 filters.

## Available references

Inside a conditional, you can reference:

- **Field values** of earlier questions, by their backing-field
 name. `{water_present}`, `{count}`, `{status}`.
- **Standard helpers**:
  - `today()`: current date.
  - `now()`: current datetime.
  - `user_role()`: the respondent's role (admin, contributor,
    viewer).
  - `user_id()`: their user id.
  - `feature_field(name)`: when the form pre-fills from an
    existing feature (edit mode), the original value.

## Examples

- **Show only if water present**:
 `{water_present} = true`.
- **Show overdue-reason field when overdue**:
 `{due_date} < today() and {status} != 'closed'`.
- **Show photo field for failures**:
 `{status} in ('failed', 'needs-repair')`.
- **Hide private fields from non-admins**:
 `user_role() = 'admin'`.

## Conditional groups and pages

The same syntax applies to **section headers** and **page
breaks**. A page break with a conditional skips the whole page
when the condition is false; useful for "skip this section if
the respondent isn't an inspector."

## Required and conditional together

A required question that's hidden by conditional logic is NOT
required when hidden. The respondent submits without filling
in the hidden field; the backing-field value stays NULL.

This is the right behavior for "required, but only if relevant"
(the most common pattern). If you want "required even when
hidden," express it as a constraint on the submission instead.

## Notes

- **Conditionals don't cycle.** A question can reference only
 fields that appear before it in the form. The designer
 surfaces a warning if you try to set a circular conditional.
- **The expression evaluates on the client.** Changes to a
 referenced field re-evaluate immediately; the question
 shows/hides as the respondent types.
- **Backing-field types matter.** A conditional `{count} > 5`
 only makes sense if `count` is numeric. The designer
 enforces type compatibility.
