# Help screenshots

Every help page that names a control, dialog, wizard, tab, button,
or multi-step UI process **must** include at least one real
screenshot of that surface. Wireframe SVGs and "figure coming soon"
placeholders are not enough.

## Where files live

- PNGs (preferred) or WebP under `apps/portal-web/public/help/`.
- Mirror the help slug: `public/help/<category>/<slug>-<view>.png`.
  Examples:
  - `public/help/getting-started/creating-your-first-map-new-item.png`
  - `public/help/analysis/buffer-analyze-guide.png`
  - `public/help/forms/form-designer-canvas.png`
- Reference from markdown as a root-relative path the portal
  serves statically:

  ```md
  ![New item wizard with Map selected](/help/getting-started/creating-your-first-map-new-item.png)
  ```

Legacy flat SVGs under `public/help/*.svg` are being replaced by
PNGs in the paths above. Do not add new wireframe SVGs.

## What to capture

- Desktop viewport **1440×900** unless the page is specifically
  about a mobile layout.
- Signed in as a normal contributor (or admin for Admin help and
  for screens only an editor sees), using the demo's published
  testers so the chrome matches what readers see.
- Crop or frame so the named control is obvious. Full-page shots
  are fine when the layout itself is the lesson (map builder,
  form designer).
- No personal email, API keys, or one-off scratch titles. Use
  golden / sample content when possible.
- One shot per distinct control or step the prose asks the reader
  to use. A page with "open the Access tab, then pick a tier"
  needs the Access tab visible; a page that only defines a
  concept with no UI steps can skip images.

## How to capture

Every image is one entry in `SHOTS` in
`e2e/scripts/capture-help-screenshots.mjs`: the file it writes, the
tester it signs in as, and the steps that bring the screen up. From
the repo root:

```bash
node e2e/scripts/capture-help-screenshots.mjs
```

It targets demo.gratisgis.org and signs in as the published testers
(`tester-contributor`, and `tester-admin` for admin pages). To redo
a few images, pass a pattern that matches their paths:

```bash
HELP_SHOT_ONLY='analysis/|admin/' node e2e/scripts/capture-help-screenshots.mjs
```

When the UI changes and an entry fails, fix that entry and rerun
it. A new image needs a new entry and a reference from the matching
`content/help/**/*.md` page, in the same PR. Look at each image
before committing: a step can succeed and still frame the wrong
screen.

## Review checklist

- [ ] Every numbered "how to" that mentions a UI control has an
      image above or beside those steps.
- [ ] Image `alt` text names the control (not "screenshot").
- [ ] PNG path matches the help slug convention above.
- [ ] Old SVG / placeholder callouts for that surface are gone.
