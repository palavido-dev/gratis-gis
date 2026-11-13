// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Clean-up for the snake_case name boxes in the data layer builder
 * (table name, field name, foreign key column).
 *
 * The boxes used to run the full clean-up on every keystroke. That
 * trims a trailing underscore, so the `_` just typed was gone before
 * the next key arrived: `parcel_id` became `parcelid`, and clearing
 * the box filled in `layer`. Now the box applies the loose form while
 * typing and the full form when it loses focus.
 */

const MAX_LENGTH = 60;

/** While typing: lowercase and turn invalid runs into `_`. Nothing is
 *  trimmed, so a trailing `_` survives until the next letter. */
export function typingIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, MAX_LENGTH);
}

/** On blur (and for names derived from a label): also strip a leading
 *  or trailing `_`. An empty result becomes `fallback`. */
export function finalIdentifier(raw: string, fallback = ''): string {
  // typingIdentifier collapses every run to one `_`, so stripping a
  // single one at each end is enough.
  const cleaned = typingIdentifier(raw.trim()).replace(/^_|_$/g, '');
  return cleaned || fallback;
}
