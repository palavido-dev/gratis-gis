---
id: getting-started-qgis-arcgis-rest
title: Edit in QGIS with ArcGIS REST
seoTitle: "Open and edit GratisGIS data layers in QGIS without a plugin"
summary: Connect stock QGIS to the portal as an ArcGIS REST server to browse, open and edit data layers. Sign in through your browser or with an API key.
category: getting-started
order: 56
complexity: intermediate
tags:
  - qgis
  - editing
  - feature-service
  - data-layer
related:
  - getting-started-arcgis-pro
  - getting-started-qgis-stac
  - reference-api-keys
---

QGIS 3.28 and newer can open and edit ArcGIS feature services with no
plugin. The portal speaks that interface, so every data layer you can
see shows up in QGIS's browser, and the ones you can edit can be
edited there. Saves land in the portal with the same permissions,
field rules and edit history as edits made in the portal.

## Add the connection

1. In QGIS, open the **Browser** panel.
2. Right-click **ArcGIS REST Servers** and choose **New Connection**.
3. **Name:** anything, for example `GratisGIS`.
4. **URL:**

   ```
   https://your-portal.org/api/geoservices/rest/services
   ```

5. Pick an **Authentication** configuration (below), or leave it
   empty to see public layers only.
6. Click **OK**, then expand the connection. Each data layer is a
   service; its layers and tables are inside.

To open one layer straight from the portal, copy its URL with **Use
in ArcGIS Pro** on the layer's page and use that URL instead.

## Sign in

QGIS has no ArcGIS sign-in prompt, so the connection carries a QGIS
authentication configuration. There are two ways.

### Sign in through your browser (recommended)

This works with every way of signing in to GratisGIS, including
Google, Microsoft and two-step codes.

1. Next to **Authentication**, click the **+** button.
2. **Name:** `GratisGIS sign-in`. **Type:** **OAuth2 authentication**.
3. **Grant flow:** **Authorization Code (PKCE)**.
4. **Request URL:**
   `https://your-auth-host/realms/gratis-gis/protocol/openid-connect/auth`
5. **Token URL:**
   `https://your-auth-host/realms/gratis-gis/protocol/openid-connect/token`
6. **Client ID:** `qgis-plugin`. Leave **Client secret** empty.
7. **Redirect URL:** host `127.0.0.1`, port `7070`.
8. **Scope:** `openid offline_access`.
9. Save, then save the connection.

To find `https://your-auth-host/realms/gratis-gis` for your portal,
open the portal's sign-in page and look at the address bar: it is
everything up to and including `/realms/gratis-gis`. QGIS opens your
browser the first time you use the connection, and stays signed in
after that.

### Sign in with an API key

1. Create a [personal API key](/help/reference/api-keys). To edit,
   untick **Read only**.
2. Next to **Authentication**, click **+**, choose **API Header**.
3. **Key:** `Authorization`. **Value:** `Bearer ggk_your_key_here`.
4. Save, then save the connection.

## Edit

1. Add a layer from the connection to your map.
2. Turn on editing (the pencil), make your changes, and save.

Everything in one save is written together or not at all. If a
feature fails a check, QGIS shows the portal's message and nothing in
that save is written.

## Things to know

- **The last save wins.** A save replaces a change someone made in
  the portal after you loaded the layer. Both stay in the history.
- **Adding or removing fields** from QGIS is not supported. Change
  the schema in the portal.
- Attachments and relationship classes are not available through
  this interface yet.
