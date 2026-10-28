---
id: admin-branding
title: Branding
summary: Customize the portal's logo, colors, fonts, and footer text. Org-wide presentation.
category: admin
order: 60
complexity: basic
tags:
  - admin
  - branding
  - theme
related:
  - admin-organization-settings
---
![Admin Landing page / branding settings](/help/admin/branding.png)

The **branding** page (admin → branding) controls the portal's
look at the org level: logo in the top bar, primary color
through the UI, font, footer text, favicon. Web apps inherit the
org brand by default but can override per app.

## What you can change

- **Logo.** A PNG or SVG that replaces "GratisGIS" in the top
 bar. Tall logos are cropped to a fixed height; wide logos
 keep their aspect ratio. Recommended: 200×60 SVG.
- **Favicon.** A 32×32 PNG or an SVG.
- **Primary color.** The accent color used throughout (button
 fills, active nav items, link color). Defaults to the
 GratisGIS sage / accent. Pick a color with sufficient
 contrast against light and dark backgrounds.
- **Font family.** Pick a Google Font (the portal proxies the
 download so no external requests at runtime) or stick with the
 system default. Pick something readable at 12px; the portal's
 UI font carries a lot of small text.
- **Footer text.** Up to ~200 characters of plain text shown on
 every page. Typical: "Hosted by Your Org. Contact
 support@yourorg.example for help."
- **Login screen background image.** A full-bleed image shown
 behind the Keycloak sign-in form (proxied through the portal).

## What this does NOT change

- **Map visual styles.** Basemaps and layer symbology are
 per-map. The branding here doesn't push a primary color into
 every map.
- **Web app theme.** The brand is the default theme for new web
 apps; existing apps with a custom theme keep theirs.
- **PDF / report template look.** Reports have their own
 templating; they don't inherit from this page.

## Per-web-app override

Each web app can override:

- Primary color.
- Logo (or no logo).
- Splash screen content.

See **Themes** under Web apps.

## Notes

- **Don't reuse Esri-branded artwork.** Avoid using Esri logos
 or art from AGO in your branding. GratisGIS doesn't use Esri
 vocabulary or art by design.
- **Test in dark mode.** The primary color you pick has to
 work on both light and dark surfaces; the portal supports
 both with a system-preference toggle.
