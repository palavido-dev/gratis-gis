---
id: items-widget-package
title: Widget package
summary: An archive item that bundles a custom Web App widget for installation on this or another portal.
category: items/advanced
order: 190
complexity: advanced
tags:
  - widget-package
  - item-type
  - web-app
related:
  - items-web-app
  - web-apps-custom-app
---

A **widget package** is an archive item that bundles a single
Custom Web App widget: the widget's manifest, runtime code, and
optional dependencies, packed into one downloadable file.

Use this item type when:

- You wrote a custom widget on one portal and want to install it
 on another.
- You're sharing a widget publicly so other GratisGIS deployments
 can pick it up.
- You're versioning a widget alongside the apps that depend on it.

## What's in the archive

- **Manifest**. The widget's id, display name, icon, configurable
 parameters, and the layer-binding contract it needs.
- **Runtime code**. The widget's compiled JavaScript bundle and
 any CSS.
- **Dependencies**. References to portal-built-in APIs the widget
 calls.
- **Sample config**. A default parameter set so the widget can be
 dropped onto a fresh app and run.

## Installing a widget package

The admin widget manager has an **Install package** action that
accepts a widget package item. Once installed, the widget shows
up in the Custom Web App builder's widget catalog under its
manifest name.

## Trust and review

Installing a widget package runs third-party JavaScript inside
your portal's web app runtime. The admin install flow shows the
widget's declared permissions (which layers it reads, which API
endpoints it calls) and requires explicit approval before
activation.

Treat widget packages from outside your org the way you'd treat
any external JavaScript bundle.

## Sharing

Standard three-tier. Public widget packages are common when an
author wants community installs; org-only packages cover internal
widget development.

## Notes

- **Widget code lives on the portal, not in the package**. The
 package is the source of truth for installing; once installed,
 the runtime code is served from your portal's static asset
 store.
- **Versioning** is per-package-item. Publish a new widget
 version as a new package, or update the file on an existing
 widget package item (an admin action; not exposed to
 contributors).
