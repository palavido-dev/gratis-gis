# Offline basemap assets

Vendored so a field device can draw a labelled map with no network at
all, and so a self-hosted portal does not quietly depend on somebody
else's CDN to render its own basemap. An air-gapped install that
fetched these at runtime would show an unlabelled map with nothing to
explain why.

## What is here

    fonts/Noto Sans {Regular,Medium,Italic}/{0-255,256-511}.pbf
    fonts/OFL.txt
    sprite/light{,@2x}.{json,png}

Roughly 680 KB in total. The two glyph ranges cover Basic Latin,
Latin-1 Supplement, Latin Extended-A and -B, and Greek. A deployment
that needs Cyrillic, Devanagari or CJK labels needs the matching
ranges added here; MapLibre asks for a range only when a label
actually contains a character in it, so the absence shows up as a
missing label rather than a broken map.

The three font weights are the stacks `@protomaps/basemaps` asks for
by name. Dropping one does not save much and produces console errors
on every label that wanted it.

## Where it came from

Both sets are from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets),
which publishes them for exactly this purpose. Fetched once rather
than at build time: a build that reaches the network to succeed is a
build that fails when the network does.

Refresh by re-running the fetch documented in
`docs/field-offline-areas.md`, and only when the style package's
expectations change. These files are stable and there is no reason to
touch them on a schedule.

## Licensing

The fonts are Noto Sans, under the SIL Open Font License 1.1, copied
verbatim to `fonts/OFL.txt`. The sprite sheet is part of the
Protomaps basemaps project, BSD-3-Clause, the same license as the
`@protomaps/basemaps` package this repository already depends on.

Map data rendered through these assets is OpenStreetMap, ODbL. The
attribution string lives with the style builder in
`src/lib/offline-basemap.ts` so it cannot drift from the thing it
attributes.
