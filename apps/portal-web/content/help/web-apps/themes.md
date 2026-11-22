---
id: web-apps-themes
title: Themes
seoTitle: "Web app themes: colors, fonts and logo"
summary: Per-web-app color, font, and logo overrides. Picks up the org brand by default; lets one app stand out.
category: web-apps
order: 90
complexity: basic
tags:
  - web-app
  - theme
  - branding
related:
  - items-web-app
  - admin-branding
---

A web app's **theme** controls its primary color, font, and
logo. By default the app inherits the org brand (see **Branding**
under Admin); the theme panel lets one app override the brand
without affecting others.

## What you can override

- **Primary color.** The button-fill / link / accent color.
 Picks up the org primary by default.
- **Logo.** Replaces (or hides) the top-bar logo for this app
 only.
- **Background color.** The page background outside the map
 area; useful when the map doesn't fill the page.
- **Font family.** Pick from the same Google Font list as org
 branding.

## What's NOT overridable per app

- **Favicon.** Org-level only.
- **Footer text.** Org-level only.
- **Map style.** The map's basemap and layer symbology are
 properties of the bound map item, not the web app's theme.

## Setting a theme

In the web app's detail page or builder, open **Theme**. Adjust
the overrides; the preview updates live. Save.

To reset to inherited org-brand defaults, click **Reset to
org defaults** on each property.

## Splash and disclaimer

The theme panel also includes splash screen and disclaimer
config, both per app:

- **Splash screen**. A modal that opens when the app first
 loads. See **Splash widget** for the widget-driven version;
 the theme-level splash is the simpler "always show this
 text first" option.
- **Disclaimer banner**. A persistent strip across the top of
 the app. Use for "DRAFT" or "FOR INTERNAL USE" indicators.

## Notes

- **Contrast matters.** Pick primary colors that contrast
 against both the map content and the chrome. The theme
 picker shows a small contrast warning when the color fails
 WCAG AA against the default UI background.
- **Theme is per-app, not per-template.** A Custom and a
 Viewer app share the same theme system; both pick their
 own.
