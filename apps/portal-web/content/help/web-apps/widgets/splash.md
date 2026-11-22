---
id: widget-splash
title: Splash widget
seoTitle: "Splash screen widget: welcome message or terms of use"
summary: A modal dialog that opens when a Custom Web App loads.  Use for welcome messages, disclaimers, or required terms of use.
category: web-apps/widgets
order: 50
complexity: basic
controls:
  - id: widget-splash-toggle
    label: "Splash tile in the widget palette"
tags:
  - widget
  - splash
  - modal
related:
  - web-apps-custom-app
---

The **Splash widget** renders a portal-rooted modal dialog every
time the app loads. Drop one onto a Custom Web App canvas, edit
the title and body, and it appears in the runtime.

<!-- screenshot: a custom app runtime with a splash dialog open, showing title + WYSIWYG body + "Don't show again" + OK button -->
## How to add one

1. Open your Custom Web App in the builder.
2. From the **Page** group in the left palette, drag **Splash** onto
 the canvas. It shows as a placeholder card (the modal itself
 is portal-rendered to `document.body` at runtime, not on the
 canvas grid).
3. In the right rail, edit the **Title** and **Body**. The body
 uses the same WYSIWYG editor as the Text widget. Bold, italics,
 headings, lists, links, color.

## Options

| Option | What it does |
|---|---|
| **Title** | Plain text shown in the dialog header. |
| **Body** | Markdown stored, edited via WYSIWYG. Renders as the modal body. |
| **Confirm button label** | Default "OK". Useful for "I agree" / "Continue" / etc. |
| **Size** | Small (400px), Medium (600px, default), Large (800px), or Custom width clamped 280-1200px. |
| **Show "Don't show again" checkbox** | When on, the user can dismiss the splash for future visits. Their preference is stored in `localStorage` keyed by app id + content hash. |
| **Require confirmation** | When on, the modal has no close X, escape does nothing, and clicking outside doesn't dismiss. The user must click the confirm button. Use for terms / disclaimers. |

## Dismissal memory

The "Don't show again" key includes a hash of the splash's
**title + body + confirm label**. When you edit any of those, the
hash changes and everyone who previously dismissed sees the new
splash on their next visit.

This is by design. It would be a bug if a re-authored disclaimer
went unseen because users had dismissed an older version.

## When not to use it

- **Don't gate critical info.** Users tune out modal walls; if the
 info needs to persist, put it on the page itself or in a
 Container.
- **Don't put it on every app.** Repeated splashes train users to
 click OK without reading. Use it for genuinely-rare events
 (first visit, version change, ToS update).
