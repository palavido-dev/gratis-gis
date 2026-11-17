# Translating GratisGIS

Thanks for helping translate GratisGIS into a new language. This
file is the contributor guide for the i18n surface. The fastest
way to help today: pick a locale below, open the matching catalog
file, fix anything that reads wrong to a native speaker, and open
a pull request.

## Platform choice

**Weblate** is the project's chosen translation platform (self-hosted
or Hosted Weblate later). Crowdin (SaaS OSS plan) and Tolgee
(open-core + paid hosted) were considered and not selected: Weblate
matches the AGPL / self-hosted stack better.

Standing up Weblate (compose, secrets, CI PR bots, completeness
badges) is **not** done yet. Until that lands, the supported
community path is still a git pull request against the TypeScript
catalogs below. When Weblate is live, the expected flow is:
translator edits on Weblate → platform opens a PR → maintainer
review → merge. Catalogs in this repo remain the source of truth
either way.

## Where the translations live

- The supported-locale list at
  `apps/portal-web/src/lib/i18n/locales.ts`.
- The English reference catalog at
  `apps/portal-web/src/lib/i18n/messages/en.ts`.
- Per-locale catalogs in the same `messages/` folder:
  `es.ts`, `pt-BR.ts`, `fr.ts`, `de.ts`.
- A vanilla `t(key, params?, locale?)` runtime at
  `apps/portal-web/src/lib/i18n/index.ts` that handles catalog
  lookup, `{name}` placeholders, and ICU-style plural cases.

## Currently supported locales

| Code | Native name | Status |
|---|---|---|
| `en` | English | Reference catalog, 100% |
| `es` | Español | Machine-translated seed; native review wanted |
| `pt-BR` | Português (Brasil) | Machine-translated seed; native review wanted |
| `fr` | Français | Machine-translated seed; native review wanted |
| `de` | Deutsch | Machine-translated seed; native review wanted |

Phase 1.1 seeded all four non-English catalogs with a
machine-translation pass so the UI is already usable in every
supported language today. The seed is good enough to read but
will have wording that sounds robotic, formality mismatches, and
the occasional outright mistranslation. That's where native
speakers come in.

The locale picker in the user menu shows an "(MT)" tag next to
locales that are still on the MT seed and links back to this
guide. Once a locale has had a real native review pass, the next
PR can flip its `machineTranslated` flag to `false` in
`locales.ts` and the tag goes away.

## Reviewing a machine-translated locale (the easy path)

1. Switch your portal to the locale you want to review (user menu
   in the top-right -> language picker).
2. Click around. Note anything that sounds wrong: too formal, too
   casual, awkward word order, mistranslated jargon, wrong word
   for a GIS concept, etc.
3. Open the matching catalog file under
   `apps/portal-web/src/lib/i18n/messages/`.
4. Fix the problem strings. Keep the keys exactly as they are;
   change only the values.
5. Open a pull request titled "i18n: <locale> review pass" with
   a short note about what you changed.

A partial review is fine. Fixing five strings is better than
fixing zero. We'll merge incremental improvement PRs as they come
in.

## Adding a brand-new locale

1. Add the BCP-47 code to `SupportedLocale` in `locales.ts`.
2. Add a `LOCALES` entry with the native + English names. Set
   `completeness: 0` and `machineTranslated: false` (you're
   shipping a human translation from the start).
3. Extend the `negotiateLocale` helper so the Accept-Language
   matcher picks up the new locale's primary subtag.
4. Create a sibling messages file, e.g.
   `apps/portal-web/src/lib/i18n/messages/it.ts` (Italian), copy
   the structure of an existing catalog, and translate each
   value.
5. Wire your catalog into the `CATALOGS` record in `index.ts`.
6. Open a pull request.

Anything you don't translate keeps showing the English value at
runtime, so partial first-pass catalogs are fine.

## Conventions

- **Key names** are dot-separated, namespaced by surface
  (`common`, `nav`, `newItem`, `mapEditor`, `comments`, etc.).
  Keep them grouped semantically, not by where they appear in
  the JSX.
- **Placeholders** use `{name}` syntax. Plural cases use
  `{count, plural, one {…} other {…}}`. The runtime currently
  ships English-default cardinal logic; locales with more
  cardinal categories (Russian's `few` / `many`, Arabic's
  `zero` / `two` / `few` / `many`) work when you supply the
  right case bodies, but the case picker is English-only in
  Phase 1.1. A later phase will swap to `Intl.PluralRules`
  per-locale so a translator can use the full cardinal
  vocabulary their language requires.
- **Don't translate proper nouns** like product names,
  organization names, "GratisGIS", or "PostGIS".
- **Match the source's tone.** The English catalog is friendly
  but not chatty: button labels are imperative ("Save," not
  "Save it"), section headers are short noun phrases. Try to
  stay in the same register.
- **Match the source's formality.** Most of the catalog uses a
  neutral-formal voice. Pick the formality convention that
  matches professional GIS tools in your locale (formal "Sie"
  in German, formal "vous" in French, etc.) and stay consistent.

## Flipping a locale off the MT seed

Once a locale has had a real native review pass and the
maintainer is comfortable that it reads correctly:

1. In `locales.ts`, set the locale's `machineTranslated` flag
   to `false`.
2. Bump its `completeness` to reflect how much of the catalog
   you've reviewed (100 once every key has been touched, lower
   if some namespaces still need attention).
3. In the catalog file itself, remove the "Machine-translated
   seed" preamble and replace it with a brief credit line for
   the reviewer if they want one.

The locale picker stops showing the "(MT)" tag and the
"Help us improve it" link once the flag is off.

## Questions

Open an issue with the `i18n` label, or comment on an open i18n
PR.
