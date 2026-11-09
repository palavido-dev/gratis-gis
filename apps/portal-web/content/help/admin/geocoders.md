---
id: admin-geocoders
title: Geocoders
summary: Make a geocoding service item from your own data or an ArcGIS GeocodeServer, and use it in a map's search bar.
category: admin
order: 20
complexity: intermediate
tags:
  - admin
  - geocoder
  - nominatim
related:
  - admin-organization-settings
---

A **geocoder** turns a typed address or place name into a location.
In GratisGIS a geocoder is an item of type **Geocoding service**,
not an admin page. Anyone who can create items can make one, and
sharing controls who can use it.

## Make one

1. **New item -> Geocoding service.** Give it a title.
2. On the item page, pick the source:
   - **Use your own data.** Search a data layer, for example a
     parcels or address points layer. Pick the layer, then the
     fields to search and how much each one counts. The search
     index builds when you save.
   - **Use an existing ArcGIS GeocodeServer.** Paste the
     GeocodeServer URL, for example a statewide locator, and probe
     it. The portal sends queries to it for you.
3. Set the options: how many candidates to return (1 to 50), the
   minimum score (0 to 1), and for your own data, a spatial extent
   and a result label template.
4. Try addresses in **Test geocoder** before anyone relies on it.

## Use it in a map

In the map editor, choose the geocoder for the map's search bar.
The search bar then shows results from that geocoder alongside
matches in the map's own layers.

## Address search without a geocoder item

The map search bar also searches addresses through the portal's
`/api/geocode` route, which uses the Nominatim instance the operator
configured with `NOMINATIM_URL`. With none configured, it falls back
to the public OpenStreetMap Nominatim service unless the operator
set `NOMINATIM_PUBLIC_FALLBACK=0`. Those are server settings, not
something you set in the portal. See `infra/NOMINATIM.md` for
running your own.

## Notes

- There is no built-in support for Photon, Pelias, Google or a
  custom HTTP geocoder, and no failover between geocoders.
- An external GeocodeServer sees every query sent to it. Check its
  terms and whether your addresses may leave your network.
