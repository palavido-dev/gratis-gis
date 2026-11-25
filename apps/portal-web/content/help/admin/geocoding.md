---
id: admin-geocoding
title: Geocoding
seoTitle: "Set up address search on a self-hosted GratisGIS portal"
summary: Pick the regions address search covers, and the portal downloads, builds and serves the address index itself.
category: admin
order: 21
complexity: intermediate
tags:
  - admin
  - geocoder
  - address search
  - open-geocode
related:
  - admin-geocoders
---
**Admin -> Geocoding** sets up address search for the whole portal:
the map search bar, What's Here, the field app, custom apps and
spreadsheet address import. Only admins of the operator organization
see it.

## Set it up

1. Open **Admin -> Geocoding**.
2. Under **Regions**, search for your state, province or country and
   add it. Add more than one if you need them.
3. Under **Data**, leave **U.S. Census address ranges** on for U.S.
   regions. Turn on **OpenAddresses** for exact matches on many more
   addresses. It needs a free token from batch.openaddresses.io.
4. Pick how often to rebuild with fresh data.
5. Click **Save and build**.

The page shows each step: downloading, building, then ready. A U.S.
state takes a few minutes. When it is ready, try an address in
**Try it**. Address search switches to the new index on its own.

## What it needs

- Disk: the download, plus a few times that while it builds. The
  first U.S. build also downloads about 2 GB of Census data, which is
  kept for the next rebuild.
- Memory: under 0.5 GB to serve a state. Building uses about 1 GB.
- Internet access from the server to download.geofabrik.de, and to
  the Census and OpenAddresses download sites when those are on.

Smaller regions build faster. A whole continent can take hours and
tens of GB of disk.

## Good to know

- Nothing is sent anywhere when people search. The index runs on your
  server.
- Until the first build finishes, address search keeps working the way
  it did before (Nominatim).
- If the server sets `OPEN_GEOCODE_URL`, the portal uses that geocoder
  instead, and the page says so.
- On a portal whose admin settings are locked (a public demo), the
  operator sets the regions with `GEOCODER_REGIONS` instead.
- Spreadsheet import takes up to 10,000 address rows with this index,
  and adds a `geocode_accuracy` column to the new layer.
