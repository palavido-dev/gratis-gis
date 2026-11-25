---
id: getting-started-arcgis-pro
title: Edit in ArcGIS Pro
seoTitle: "Open and edit GratisGIS data layers in ArcGIS Pro"
summary: Add a data layer to ArcGIS Pro by URL, sign in with your GratisGIS account, and edit features. Saves land in the portal with full history.
category: getting-started
order: 55
complexity: basic
tags:
  - arcgis-pro
  - editing
  - feature-service
  - data-layer
related:
  - getting-started-qgis-arcgis-rest
  - items-data-layer
  - reference-api-keys
---

Every data layer can be opened in ArcGIS Pro as a web feature layer.
You can view it, filter it, label and symbolize it, and, if you have
edit rights, add, move, reshape and delete features and change their
attributes. What you save in Pro lands in the portal like any other
edit: the same permissions, the same field rules, and the same edit
history.

## What you need

- ArcGIS Pro 3.x.
- A GratisGIS account that can see the layer. To edit, you need edit
  rights on it, the same as in the portal.
- The layer's service URL, from the layer's page in the portal.

## Get the URL

1. Open the data layer's page in the portal.
2. Click **Use in ArcGIS Pro**.
3. Click **Copy**.

![Use in ArcGIS Pro open on a data layer page, with the service URL, a Copy button and three steps](/help/getting-started/arcgis-pro-use-in-pro.png)

The URL ends in `/FeatureServer`. It looks like this:

```
https://your-portal.org/api/geoservices/rest/services/Parcels_0193f2a4-.../FeatureServer
```

## Add it to a map in Pro

1. In ArcGIS Pro, open a map.
2. On the **Map** tab, click **Add Data**, then **Data From Path**.
3. Paste the URL and click **Add**.

Pro adds the item's layers and tables to the map.

## Sign in

A public layer opens without signing in. For anything else, Pro asks
for a user name and password:

- **User name:** your GratisGIS user name (or your email address).
- **Password:** your GratisGIS password.

If you sign in to GratisGIS with Google, Microsoft or another single
sign-on, or with a two-step code, Pro's prompt cannot check that. Use
a [personal API key](/help/reference/api-keys) as the password
instead. To edit, untick **Read only** when you create the key: a
read-only key can view but not save.

## Edit

Edit as you would any web feature layer: the **Edit** tab, **Create**,
**Modify**, the attribute table. Then **Save**.

- **One save, one change.** Everything in a save is written together,
  across all the item's layers, or not at all. If one feature fails a
  check, nothing in that save is written and Pro shows why.
- **Field rules apply.** Required fields, pick lists and number
  ranges are enforced as they are in the portal.
- **History.** Each saved edit is in the layer's history in the
  portal, with your name and the time.
- **Your limits apply.** If your access is limited to an area or to
  the features you created, Pro can only change those.

## Things to know

- **The last save wins.** If someone edits a feature in the portal
  after you opened it in Pro, and you then save your own change to
  that feature, your save replaces theirs. Both versions stay in the
  history, so nothing is lost, but refresh before long edit sessions
  on shared layers.
- **Not yet supported:** attachments, relationship classes, curved
  geometry (densify curves before saving), offline sync, and adding
  or removing fields from Pro. Change the schema in the portal.
- **Layer numbers stay put.** Each layer keeps its number in the
  service, so a saved Pro project keeps pointing at the right layer
  after layers are added to or removed from the item.

## Troubleshooting

- **Pro asks for a password again and again.** Check the user name
  and password in the portal. If you use Google, Microsoft or a
  two-step code, use an API key as the password.
- **"This API key is read-only."** Make a key with **Read only**
  unticked.
- **"The geometry is outside the area you may edit."** Your access to
  this layer is limited to an area. Ask the layer's owner.
- **"Someone else changed this feature since it was read."** Another
  save landed while yours was on its way. Refresh the layer and make
  the edit again.

## For QGIS

QGIS can open the same layers. See
[Edit in QGIS with ArcGIS REST](/help/getting-started/qgis-arcgis-rest).
