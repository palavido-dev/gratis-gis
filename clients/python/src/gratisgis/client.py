# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synchronous client for a GratisGIS portal.

Deliberately synchronous. The audience is a notebook cell, a cron
script, or a CI step, and none of them should have to think about an
event loop to read a layer. The QGIS plugin's async client remains the
right shape for a GUI that must not block its main thread; this is the
same endpoints without the ceremony.

The surface is intentionally small. This wraps the portal's item API
and its v3 feature endpoints, which is what automation actually needs.
It is not trying to mirror every route the portal exposes.

    from gratisgis import GratisGIS

    gg = GratisGIS("https://gratisgis.org", api_key="ggk_...")
    layer = gg.find_items(type="data_layer", query="parcels")[0]
    fc = gg.read_features(layer["id"], "parcels", limit=500)
"""

from __future__ import annotations

import json
import os
from mimetypes import guess_type
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple, Union

import httpx

from .errors import (
    AuthError,
    ConflictError,
    NotFoundError,
    PortalError,
    RateLimitError,
    ValidationError,
)

__all__ = ["GratisGIS", "field", "layer", "buffer", "step"]

# Declared here rather than in __init__, which imports this module:
# the default User-Agent below needs it, and a second literal would
# drift from the package version the first time one of them is bumped
# alone.
__version__ = "0.6.0"

# The portal caps a single append at 5000 features (AppendFeaturesBodyDto).
# Batch below it so a caller handing us a million rows just works.
MAX_APPEND_BATCH = 1000

#: Field types a layer may declare. Mirrors FeatureFieldType in
#: packages/shared-types/src/data-layer.ts.
FIELD_TYPES = ("string", "number", "boolean", "date", "multi_select")

#: Broad visibility tiers for an item.
ITEM_ACCESS = ("private", "org", "public")

#: What one share may allow. Ascending; each includes the ones before.
#: Note `admin` here does NOT permit deleting the item, which stays with
#: the owner and org admins.
SHARE_PERMISSIONS = ("view", "download", "edit", "admin")

#: Geometry a layer may hold. ``None`` means an attribute-only table,
#: which is a real and supported thing, not a missing value. Note these
#: are the portal's lowercase names, not GeoJSON's ``Point`` /
#: ``LineString`` / ``Polygon``.
GEOMETRY_TYPES = ("point", "line", "polygon", None)

#: What :meth:`GratisGIS.export_layer` can write. The portal exposes one
#: route per format rather than a ``format=`` parameter, so this maps
#: name to route segment and to the content type it returns.
EXPORT_FORMATS = {
    "geoparquet": ("geoparquet", "application/vnd.apache.parquet"),
    "csv": ("csv", "text/csv"),
    "geojson": ("geojson", "application/geo+json"),
}


#: Distance units a buffer accepts.
LENGTH_UNITS = ("meters", "kilometers", "feet", "yards", "miles")

#: Every geoprocessing step a derived layer can run, server-side.
#: Build the common ones with the helpers below; the rest are plain
#: dicts of ``{"tool": name, "params": {...}}``.
TOOLS = (
    "buffer",
    "dissolve",
    "centroid",
    "convex-hull",
    "bbox",
    "simplify",
    "vertices",
    "densify",
    "top-n",
    "random-sample",
    "nearest-neighbor",
    "fishnet",
    "calculate-geometry",
    "filter",
    "calculate-field",
    "aggregate",
    "spatial-join",
    "spatial-filter",
    "clip",
    "erase",
    "contour",
)


def buffer(distance: float, unit: str = "meters") -> Dict[str, Any]:
    """A buffer step, for :meth:`GratisGIS.create_derived_layer`.

    Runs as ``ST_Buffer`` on the geography type, so the distance is
    correct anywhere on the globe and you do not have to pick a
    projection. Capped at 100 km.

    Pass a field name instead of a number to buffer each feature by its
    own value: ``buffer("setback_ft", "feet")``.
    """
    if unit not in LENGTH_UNITS:
        raise ValueError(
            f"Unknown unit {unit!r}. One of: {', '.join(LENGTH_UNITS)}."
        )
    if isinstance(distance, str):
        params: Dict[str, Any] = {
            "mode": "field",
            "field": distance,
            "unit": unit,
        }
    else:
        if distance <= 0:
            raise ValueError("Buffer distance must be greater than zero.")
        params = {"mode": "fixed", "distance": distance, "unit": unit}
    return {"tool": "buffer", "params": params}


def step(tool: str, **params: Any) -> Dict[str, Any]:
    """Any other pipeline step, by name.

    ``step("dissolve", fields=["county"])``. The parameter names are the
    portal's, so check the tool in the portal's own pipeline editor if
    you are unsure what one takes.
    """
    if tool not in TOOLS:
        raise ValueError(
            f"Unknown tool {tool!r}. One of: {', '.join(TOOLS)}."
        )
    return {"tool": tool, "params": dict(params)}


def _host_of(url: str) -> str:
    """Just enough of a URL to say which host an upload was aimed at."""
    without_scheme = url.split("://", 1)[-1]
    return without_scheme.split("/", 1)[0]


def _attachment_key(attachment: Dict[str, Any]) -> str:
    """The storage key to download, from an attachment record.

    The record's ``storageUrl`` is a path into the WEB app's proxy
    (``/api/portal/storage/...``), not the API. Fetching it against the
    API base gives a 404 that looks like a missing file. The stable part
    is the uuid on the end, which is what the API's own route takes.
    """
    url = attachment.get("storageUrl")
    if not isinstance(url, str) or not url:
        raise ValueError(
            "That does not look like an attachment record; expected one of "
            "the dicts returned by attachments()."
        )
    key = url.rstrip("/").rsplit("/", 1)[-1]
    if not key:
        raise ValueError(f"Could not read a storage key out of {url!r}.")
    return key


def field(
    name: str,
    type: str = "string",
    label: Optional[str] = None,
    *,
    nullable: bool = True,
    searchable: bool = False,
) -> Dict[str, Any]:
    """One column of a layer, for :meth:`GratisGIS.create_data_layer`.

    ``label`` is what people see and defaults to ``name``. Marking a
    field ``searchable`` asks the portal to index it, which is worth it
    on the one or two fields anybody looks things up by and wasteful on
    the rest.
    """
    if type not in FIELD_TYPES:
        raise ValueError(
            f"Unknown field type {type!r}. One of: {', '.join(FIELD_TYPES)}."
        )
    spec: Dict[str, Any] = {
        "name": name,
        "type": type,
        "label": label if label is not None else name,
        "nullable": nullable,
    }
    if searchable:
        spec["searchable"] = True
    return spec


def layer(
    id: str,
    label: str,
    geometry_type: Optional[str],
    fields: Iterable[Dict[str, Any]],
    *,
    name: Optional[str] = None,
    editing_enabled: bool = True,
    attachments_enabled: bool = False,
) -> Dict[str, Any]:
    """One layer of a data layer item.

    ``id`` is what appears in every later call and in the URL, so pick
    something short and stable; ``label`` is the display name and can
    change freely. ``geometry_type`` is ``'point'``, ``'line'``,
    ``'polygon'``, or ``None`` for an attribute-only table, which is a
    supported thing rather than a missing value.

    Note these are the portal's names, not GeoJSON's: ``line``, not
    ``LineString``.
    """
    if geometry_type not in GEOMETRY_TYPES:
        raise ValueError(
            f"Unknown geometry type {geometry_type!r}. One of: "
            "'point', 'line', 'polygon', or None for a table."
        )
    return {
        "id": id,
        "label": label,
        "name": name if name is not None else id.replace("-", "_"),
        "geometryType": geometry_type,
        "fields": [dict(f) for f in fields],
        "editingEnabled": editing_enabled,
        "attachmentsEnabled": attachments_enabled,
    }


class GratisGIS:
    """A connection to one portal, authenticated with an API key.

    Create a key at Profile -> API keys in the portal. Keys act as the
    user who created them: same sharing, same geographic limits. A key
    marked read-only is refused on writes, and no key is accepted on
    admin endpoints.
    """

    def __init__(
        self,
        portal_url: str,
        *,
        api_key: str,
        timeout: float = 60.0,
        verify_tls: bool = True,
        user_agent: str = f"gratisgis-python/{__version__}",
        client: Optional[httpx.Client] = None,
    ) -> None:
        if not api_key:
            raise ValueError(
                "An API key is required. Create one at Profile -> API keys "
                "in the portal, or use GratisGIS.from_env()."
            )
        self.portal_url = portal_url.rstrip("/")
        # Remembered for the attachment upload, which needs its own
        # client: the presigned PUT goes to object storage and must not
        # carry this one's Authorization header.
        self._verify_tls = verify_tls
        # Layer definitions, keyed by (item, layer). Filters are checked
        # against these before they are sent, and a schema does not
        # change under a script often enough to be worth re-reading on
        # every call.
        self._schema_cache: Dict[Tuple[str, str], Dict[str, Any]] = {}
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=f"{self.portal_url}/api",
            timeout=httpx.Timeout(timeout, connect=10.0),
            verify=verify_tls,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "User-Agent": user_agent,
            },
            # A reverse proxy canonicalizing www / no-www or http /
            # https must not break every authenticated call.
            follow_redirects=True,
        )

    @classmethod
    def from_env(cls, **kwargs: Any) -> "GratisGIS":
        """Build from ``GRATISGIS_URL`` and ``GRATISGIS_API_KEY``.

        The shape a scheduled job wants: no secret in the source, and
        the same script runs anywhere the two variables are set.
        """
        url = os.environ.get("GRATISGIS_URL")
        key = os.environ.get("GRATISGIS_API_KEY")
        missing = [
            n
            for n, v in (("GRATISGIS_URL", url), ("GRATISGIS_API_KEY", key))
            if not v
        ]
        if missing:
            raise ValueError(f"Missing environment variable(s): {', '.join(missing)}")
        assert url and key  # for type checkers; validated above
        return cls(url, api_key=key, **kwargs)

    # ---------------------------------------------------------------
    # context manager / lifecycle
    # ---------------------------------------------------------------

    def __enter__(self) -> "GratisGIS":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    # ---------------------------------------------------------------
    # transport
    # ---------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Any = None,
    ) -> Any:
        try:
            response = self._client.request(
                method, path, params=params, json=json
            )
        except httpx.RequestError as exc:
            raise PortalError(
                f"Could not reach the portal: {exc}", method=method, path=path
            ) from exc
        return self._handle(response, method=method, path=path)

    @staticmethod
    def _handle(response: httpx.Response, *, method: str, path: str) -> Any:
        if response.is_success:
            if response.status_code == 204 or not response.content:
                return None
            try:
                return response.json()
            except ValueError as exc:
                raise PortalError(
                    "The portal returned a response that was not JSON.",
                    status=response.status_code,
                    method=method,
                    path=path,
                ) from exc

        # Prefer the portal's own message: it writes them for humans.
        body: Any = None
        message = f"HTTP {response.status_code}"
        try:
            body = response.json()
            if isinstance(body, dict) and isinstance(body.get("message"), str):
                message = body["message"]
        except ValueError:
            text = response.text.strip()
            if text:
                message = text[:400]

        shared = {
            "status": response.status_code,
            "method": method,
            "path": path,
            "body": body,
        }
        code = response.status_code
        if code in (401, 403):
            raise AuthError(message, **shared)
        if code == 404:
            raise NotFoundError(message, **shared)
        if code == 409:
            raise ConflictError(message, **shared)
        if code == 429:
            retry = response.headers.get("retry-after")
            raise RateLimitError(
                message,
                retry_after=float(retry) if retry and retry.isdigit() else None,
                **shared,
            )
        if code in (400, 422):
            raise ValidationError(message, **shared)
        raise PortalError(message, **shared)

    # ---------------------------------------------------------------
    # identity
    # ---------------------------------------------------------------

    def whoami(self) -> Dict[str, Any]:
        """The account this key acts as. The cheapest way to check that
        a key works and to see which portal identity it carries."""
        return self._request("GET", "/users/me")

    def portal_info(self) -> Dict[str, Any]:
        """Portal name, version, and auth configuration. Unauthenticated
        on the server side, so it also works as a reachability probe."""
        return self._request("GET", "/portal-info")

    # ---------------------------------------------------------------
    # items
    # ---------------------------------------------------------------

    def find_items(
        self,
        *,
        type: Optional[str] = None,
        query: Optional[str] = None,
        limit: int = 50,
        full: bool = False,
    ) -> List[Dict[str, Any]]:
        """Search items visible to this key.

        ``full=True`` asks the portal for each item's ``data`` payload,
        which is what you want when you need storage keys or layer
        definitions and what you should avoid when you just need titles.
        """
        params: Dict[str, Any] = {"limit": limit}
        if type:
            params["type"] = type
        if query:
            # The portal reads this as `q`. It was sent as `query` until
            # 0.3.0, which the server ignored silently, so every search
            # quietly returned an unfiltered list of the first `limit`
            # items and looked like it had worked.
            params["q"] = query
        if full:
            params["full"] = 1
        result = self._request("GET", "/items", params=params)
        # The list endpoint returns a bare array; tolerate a wrapped
        # shape too so a future envelope does not break callers.
        if isinstance(result, dict) and isinstance(result.get("items"), list):
            return result["items"]
        return result if isinstance(result, list) else []

    def item(self, item_id: str) -> Dict[str, Any]:
        """One item by id, including its ``data`` payload."""
        result = self._request("GET", f"/items/{item_id}")
        if isinstance(result, dict) and isinstance(result.get("item"), dict):
            return result["item"]
        return result

    def update_item(self, item_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        """Sparse update. Only the keys present are changed.

        One exception, and it is the one that bites: ``data`` is a whole
        column, not a merge. Patching it replaces the entire payload.
        Use :meth:`add_layer` rather than hand-building a ``data`` patch
        for a layer.
        """
        return self._request("PATCH", f"/items/{item_id}", json=patch)

    def delete_item(self, item_id: str, *, cascade: bool = False) -> None:
        """Move an item to the trash.

        Reversible: see :meth:`restore_item`. Nothing is actually
        destroyed until :meth:`purge_item`.

        Deleting a folder that contains subfolders is refused unless
        ``cascade=True``, because the subfolders would be orphaned. The
        error names them, so you can look before agreeing.

        Needs to be the owner or an org admin. Note that an ``admin``
        SHARE is not enough; deleting is deliberately not delegable.
        """
        params = {"cascade": "true"} if cascade else None
        try:
            self._request("DELETE", f"/items/{item_id}", params=params)
        except ConflictError as err:
            preview = (err.body or {}).get("cascade") if isinstance(err.body, dict) else None
            folders = (preview or {}).get("folders") or []
            names = ", ".join(str(f.get("title")) for f in folders) or "some"
            raise ConflictError(
                f"{item_id} is a folder containing {names}. "
                "Pass cascade=True to trash those too.",
                status=err.status,
                method=err.method,
                path=err.path,
                body=err.body,
            ) from err

    def restore_item(self, item_id: str) -> Dict[str, Any]:
        """Bring an item back out of the trash."""
        return self._request("POST", f"/items/{item_id}/restore")

    def purge_item(self, item_id: str) -> None:
        """Destroy a trashed item and its features. Not reversible.

        The item has to be in the trash already, so this cannot be the
        first thing that happens to a live layer by accident.
        """
        self._request("DELETE", f"/items/{item_id}/purge")

    # ---------------------------------------------------------------
    # sharing
    # ---------------------------------------------------------------

    def set_access(self, item_id: str, access: str) -> Dict[str, Any]:
        """Set the broad visibility tier: private, org, or public."""
        if access not in ITEM_ACCESS:
            raise ValueError(
                f"Unknown access {access!r}. One of: {', '.join(ITEM_ACCESS)}."
            )
        return self.update_item(item_id, {"access": access})

    def share_item(
        self,
        item_id: str,
        *,
        permission: str,
        user_id: Optional[str] = None,
        group_id: Optional[str] = None,
        geo_boundary_id: Optional[str] = None,
        row_scope: Optional[str] = None,
        expires_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Share an item with one user or one group.

        ``permission`` is required rather than defaulting, deliberately.
        The endpoint is an upsert, and omitting the permission on a
        re-share rewrites an existing share down to `view`. A silent
        downgrade is a worse default than making people say what they
        mean.

        ``geo_boundary_id`` clips what this share can see to a
        geo_boundary item. ``row_scope='own'`` limits an editor to the
        rows they created.

        Needs to be the owner or an org admin.
        """
        if permission not in SHARE_PERMISSIONS:
            raise ValueError(
                f"Unknown permission {permission!r}. "
                f"One of: {', '.join(SHARE_PERMISSIONS)}."
            )
        if (user_id is None) == (group_id is None):
            raise ValueError("Pass exactly one of user_id or group_id.")
        body: Dict[str, Any] = {
            "principalType": "user" if user_id else "group",
            "principalId": user_id or group_id,
            "permission": permission,
        }
        if geo_boundary_id is not None:
            body["geoBoundaryId"] = geo_boundary_id
        if row_scope is not None:
            if row_scope not in ("all", "own"):
                raise ValueError("row_scope must be 'all' or 'own'.")
            body["rowScope"] = row_scope
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return self._request("POST", f"/items/{item_id}/share", json=body)

    def unshare_item(
        self,
        item_id: str,
        *,
        user_id: Optional[str] = None,
        group_id: Optional[str] = None,
    ) -> None:
        """Remove one user's or group's share."""
        if (user_id is None) == (group_id is None):
            raise ValueError("Pass exactly one of user_id or group_id.")
        self._request(
            "DELETE",
            f"/items/{item_id}/share",
            json={
                "principalType": "user" if user_id else "group",
                "principalId": user_id or group_id,
            },
        )

    def shares(self, item_id: str) -> List[Dict[str, Any]]:
        """Who this item is shared with. Read off the item itself."""
        found = self.item(item_id).get("shares")
        return found if isinstance(found, list) else []

    def permissions(self, item_id: str) -> Dict[str, Any]:
        """What THIS key can do with an item: read, edit, download, admin."""
        return self._request("GET", f"/items/{item_id}/permissions")

    # ---------------------------------------------------------------
    # features
    # ---------------------------------------------------------------

    def layer_schema(self, item_id: str, layer: str) -> Dict[str, Any]:
        """The definition of one layer: its fields, geometry, labels.

        Cached per client instance. Reading it is how the filter
        arguments below get checked before they are sent, and it is also
        the thing you want when writing a script against a layer you did
        not create.
        """
        cache = self._schema_cache.get((item_id, layer))
        if cache is not None:
            return cache
        item = self.item(item_id)
        data = item.get("data") or {}
        layers = data.get("layers") or []
        for candidate in layers:
            if candidate.get("id") == layer:
                self._schema_cache[(item_id, layer)] = candidate
                return candidate
        known = ", ".join(str(l.get("id")) for l in layers) or "none"
        raise NotFoundError(
            f"Item {item_id} has no layer {layer!r}. Layers on this item: {known}. "
            "Note the layer id is the layer's id, not its name or label.",
            status=404,
            method="GET",
            path=f"/items/{item_id}",
        )

    def _assert_field(self, item_id: str, layer: str, field: str) -> None:
        """Refuse a filter on a field the layer does not have.

        Checked here rather than left to the portal, because the portal
        drops an unrecognised filter field SILENTLY and returns the
        whole layer. A caller who mistypes a field name would otherwise
        get every row back and no indication that their filter was
        discarded, which is a wrong answer wearing the costume of a
        right one.
        """
        schema = self.layer_schema(item_id, layer)
        names = {f.get("name") for f in schema.get("fields") or []}
        parent_fk = schema.get("parentFkColumn")
        if parent_fk:
            names.add(parent_fk)
        if field not in names:
            raise ValueError(
                f"Layer {layer!r} has no field {field!r}. "
                f"Fields: {', '.join(sorted(n for n in names if n)) or 'none'}."
            )

    def read_features(
        self,
        item_id: str,
        layer: str,
        *,
        limit: Optional[int] = None,
        bbox: Optional[Iterable[float]] = None,
        cursor: Optional[str] = None,
        at: Optional[str] = None,
        parent_fk: Optional[str] = None,
        parent_id: Optional[str] = None,
        time_field: Optional[str] = None,
        time_from: Optional[str] = None,
        time_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """One GeoJSON FeatureCollection for a layer of a data layer.

        Server-side sharing and geographic limits apply, so this can
        return fewer features than the layer holds. That is the same
        view the user would get in the browser.

        With ``limit`` or ``cursor``, the portal returns one page plus
        two extra members: ``nextCursor`` (pass it back as ``cursor``,
        or None at the end) and ``asOf`` (pass it back as ``at`` to
        keep every page on one snapshot). With neither, it returns the
        whole collection, which on a large layer is a lot of memory and
        one very slow request. Prefer :meth:`iter_features`, which
        handles all of that.

        Filtering, honestly. The portal has no general attribute
        predicate: there is no ``where=``. What it does have is three
        specific filters, exposed here under their real names rather
        than dressed up as something more general:

        ``bbox``
            ``(minx, miny, maxx, maxy)`` in WGS84.
        ``parent_fk`` + ``parent_id``
            Exact equality on one field. Both are required together.
        ``time_field`` + ``time_from`` / ``time_to``
            An inclusive date range on one date field. ISO dates.

        Anything else is a client-side filter over
        :meth:`iter_features`, or :meth:`search_features` for text
        containment. That is a real limitation and it is better stated
        than papered over with a ``where=`` that only supports equality.
        """
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if bbox is not None:
            params["bbox"] = ",".join(str(v) for v in bbox)
        if cursor is not None:
            params["cursor"] = cursor
        if at is not None:
            params["at"] = at

        if (parent_fk is None) != (parent_id is None):
            raise ValueError(
                "parent_fk and parent_id go together: pass both to filter on "
                "a field, or neither. On its own the portal ignores it."
            )
        if parent_fk is not None and parent_id is not None:
            self._assert_field(item_id, layer, parent_fk)
            params["parentFk"] = parent_fk
            params["parentId"] = parent_id

        if time_field is not None:
            if time_from is None and time_to is None:
                raise ValueError(
                    "time_field needs at least one of time_from or time_to."
                )
            self._assert_field(item_id, layer, time_field)
            params["timeField"] = time_field
            if time_from is not None:
                params["timeFrom"] = time_from
            if time_to is not None:
                params["timeTo"] = time_to
        elif time_from is not None or time_to is not None:
            raise ValueError(
                "time_from and time_to need a time_field to apply to."
            )

        # `/features`, not `/geojson`. Same controller, same response
        # body, and it is the only one of the two that accepts the
        # filters above.
        return self._request(
            "GET", f"/items/{item_id}/layers/{layer}/features", params=params
        )

    def search_features(
        self,
        item_id: str,
        layer: str,
        q: str,
        *,
        fields: Optional[Iterable[str]] = None,
        limit: int = 25,
    ) -> List[Dict[str, Any]]:
        """Find features whose text contains ``q``.

        Containment, case-insensitive, never an exact match and never a
        comparison: this is the portal's search box, not a query
        language. With ``fields`` the match is restricted to those
        fields; without it, every attribute is searched.

        Returns a list of ``{id, properties, point, bbox}``. Capped at
        50 by the portal. For anything bigger, iterate and filter.
        """
        params: Dict[str, Any] = {"q": q, "limit": limit}
        if fields is not None:
            names = list(fields)
            for name in names:
                self._assert_field(item_id, layer, name)
            params["fields"] = ",".join(names)
        result = self._request(
            "GET",
            f"/items/{item_id}/layers/{layer}/features-search",
            params=params,
        )
        if isinstance(result, dict):
            found = result.get("results")
            return found if isinstance(found, list) else []
        return []

    def iter_features(
        self, item_id: str, layer: str, *, page_size: int = 1000, **kwargs: Any
    ) -> Iterator[Dict[str, Any]]:
        """Yield every matching feature, one at a time, in pages.

        This is the read to reach for on anything but a small layer:
        memory stays proportional to ``page_size`` rather than to the
        layer, and nothing is silently capped.

        Paging is keyset-based on the portal side (a cursor over stable
        feature ids, never an offset), so concurrent edits cannot shift
        a feature between pages and cause a duplicate or a miss. The
        snapshot instant is pinned from the first page and sent back on
        every subsequent one, so a feature created while you iterate
        does not appear halfway through the walk.
        """
        cursor: Optional[str] = None
        at: Optional[str] = kwargs.pop("at", None)
        while True:
            page = self.read_features(
                item_id,
                layer,
                limit=page_size,
                cursor=cursor,
                at=at,
                **kwargs,
            )
            for feature in page.get("features", []):
                yield feature
            cursor = page.get("nextCursor")
            # Stop only on an explicit end-of-data signal. A page can
            # come back with no features and still have more behind it
            # (deleted rows occupy page slots), so breaking on an empty
            # page would truncate the read silently.
            if cursor is None:
                return
            # Pin the snapshot from the first page onward.
            if at is None:
                at = page.get("asOf")

    def export_layer(
        self,
        item_id: str,
        layer: str,
        *,
        format: str = "geoparquet",
        path: Optional[Union[str, "os.PathLike[str]"]] = None,
        bbox: Optional[Iterable[float]] = None,
        at: Optional[str] = None,
        geometry: Optional[str] = None,
    ) -> Union[bytes, Path]:
        """Download a whole layer in one call.

        ``format`` is ``geoparquet`` (default), ``csv``, or ``geojson``.
        With ``path``, the bytes are streamed to that file and the
        :class:`pathlib.Path` is returned; without it, you get the bytes.
        Streaming matters: a county parcel layer is not something to
        hold in memory twice.

        Two things worth knowing before you pick a format.

        ``geoparquet`` walks the layer with the keyset iterator, so it
        exports everything. ``csv`` goes through the read path and stops
        at the portal's 100,000 row ceiling, silently. On a big layer
        those two give different answers, and only one of them is the
        whole layer.

        ``csv`` also takes ``geometry``: ``none``, ``wkt``, ``lonlat``,
        or ``auto``.

        Exporting bulk data needs download permission, which is a step
        above being able to see the layer on a map. A view-only share
        gets a clear 403 rather than a truncated file.
        """
        try:
            segment, _content_type = EXPORT_FORMATS[format]
        except KeyError:
            raise ValueError(
                f"Unknown export format {format!r}. "
                f"Choose one of: {', '.join(sorted(EXPORT_FORMATS))}."
            ) from None
        if geometry is not None and format != "csv":
            raise ValueError("geometry= only applies to the csv format.")

        params: Dict[str, Any] = {}
        if bbox is not None:
            params["bbox"] = ",".join(str(v) for v in bbox)
        if at is not None:
            params["at"] = at
        if geometry is not None:
            params["geometry"] = geometry

        url = f"/items/{item_id}/layers/{layer}/{segment}"
        try:
            with self._client.stream("GET", url, params=params) as response:
                if not response.is_success:
                    # Read the body before _handle can look at it: a
                    # streamed response has none until it is consumed,
                    # and the portal's error message is the useful part.
                    response.read()
                    self._handle(response, method="GET", path=url)
                if path is None:
                    return b"".join(response.iter_bytes())
                target = Path(path)
                with open(target, "wb") as fh:
                    for chunk in response.iter_bytes():
                        fh.write(chunk)
                return target
        except httpx.RequestError as exc:
            raise PortalError(
                f"Could not reach the portal: {exc}", method="GET", path=url
            ) from exc

    def calculate_field(
        self,
        item_id: str,
        layer: str,
        expression: str,
        output_name: str,
        *,
        output_type: str = "string",
        scope: str = "all",
        selected_ids: Optional[Iterable[str]] = None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """Compute a value for every feature and write it to a field.

        Saves a read-modify-write loop over the whole layer::

            gg.calculate_field(item, "parcels",
                "{{acres}} * 4046.86", "area_m2", output_type="number")

        The expression language is the portal's own, not Python and not
        SQL. Fields are ``{{name}}``, string concatenation is ``~~``,
        and the built-ins are upper, lower, length, concat, coalesce,
        abs, round, floor, ceil, and if.

        Start with ``dry_run=True``. It returns the same summary with a
        five-row sample of before-and-after values and writes nothing,
        which is the cheapest way to find out that your expression means
        something other than you thought.

        Returns ``{totalRows, appliedRows, sample, errors}``. Rows whose
        expression fails become null and count in ``errors`` rather than
        failing the whole call. Capped at 10,000 rows per call.
        """
        if output_type not in ("number", "string", "boolean"):
            raise ValueError(
                "output_type must be 'number', 'string', or 'boolean'."
            )
        if scope not in ("all", "selection"):
            raise ValueError("scope must be 'all' or 'selection'.")
        body: Dict[str, Any] = {
            "expression": expression,
            "outputName": output_name,
            "outputType": output_type,
            "scope": scope,
            "dryRun": dry_run,
        }
        if scope == "selection":
            ids = list(selected_ids or [])
            if not ids:
                raise ValueError("scope='selection' needs selected_ids.")
            body["selectedIds"] = ids
        elif selected_ids is not None:
            raise ValueError("selected_ids only applies to scope='selection'.")
        return self._request(
            "POST",
            f"/items/{item_id}/layers/{layer}/features/calculate-field",
            json=body,
        )

    # ---------------------------------------------------------------
    # server-side geometry: derived layers
    # ---------------------------------------------------------------

    def preview_pipeline(
        self,
        source_item_id: str,
        layer: str,
        pipeline: Iterable[Dict[str, Any]],
        *,
        up_to: Optional[int] = None,
        limit: int = 50,
        at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run a geoprocessing pipeline and look at the first few rows.

        Nothing is saved. This is how you check that a buffer distance
        or a filter means what you meant before committing it, and how
        you debug a pipeline step by step with ``up_to``.

        Sample size is capped server-side, so this stays cheap on a
        large layer.
        """
        steps = [dict(s) for s in pipeline]
        if not steps:
            raise ValueError("A pipeline needs at least one step.")
        # Exactly these keys. This endpoint validates strictly, so an
        # extra one is a 400 rather than an ignored field.
        body: Dict[str, Any] = {
            "source": {
                "kind": "data_layer",
                "itemId": source_item_id,
                "layerKey": layer,
            },
            "pipeline": steps,
            "limit": limit,
        }
        if up_to is not None:
            body["upTo"] = up_to
        if at is not None:
            body["at"] = at
        return self._request("POST", "/items/derived-layer:preview", json=body)

    def create_derived_layer(
        self,
        title: str,
        source_item_id: str,
        layer: str,
        pipeline: Iterable[Dict[str, Any]],
        *,
        description: str = "",
        tags: Optional[Iterable[str]] = None,
        access: str = "private",
        feature_limit: int = 1000,
    ) -> Dict[str, Any]:
        """Save a geoprocessing pipeline as a layer of its own.

        The important part: a derived layer is a **recipe**, not a copy.
        It is evaluated when read, in PostGIS, so it never goes stale
        and nothing is duplicated. Buffer a parcels layer and the buffer
        follows every later edit to the parcels.

        The result reads like any other layer, so
        :meth:`read_features`, :meth:`iter_features` and
        :meth:`export_layer` all work on it unchanged.

        This is also the answer to "can the server do the geometry so I
        do not have to download the layer". Yes, for vector work:
        buffer, dissolve, clip, erase, spatial joins and the rest run in
        the database. Build the steps with :func:`buffer` and friends,
        or hand-write them.
        """
        steps = [dict(s) for s in pipeline]
        if not steps:
            raise ValueError(
                "A derived layer needs at least one step; with none it would "
                "just be the source layer."
            )
        payload: Dict[str, Any] = {
            "type": "derived_layer",
            "title": title,
            "description": description,
            "access": access,
            "data": {
                "version": 1,
                "source": {
                    "kind": "data_layer",
                    "itemId": source_item_id,
                    "layerKey": layer,
                },
                "pipeline": steps,
                "featureLimit": feature_limit,
            },
        }
        if tags is not None:
            payload["tags"] = list(tags)
        return self._request("POST", "/items", json=payload)

    # ---------------------------------------------------------------
    # geocoding
    # ---------------------------------------------------------------

    def find_geocoders(self) -> List[Dict[str, Any]]:
        """Geocoding services this key can see.

        There is no single portal-wide geocoder. A geocoder is an item
        somebody configured, either over one of the org's own layers or
        pointing at an external locator, so :meth:`geocode` needs to
        know which one you mean and this is how you find out.
        """
        return self.find_items(type="geocoding_service", limit=50)

    def geocode(
        self,
        item_id: str,
        text: str,
        *,
        bbox: Optional[Iterable[float]] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Look an address or place name up against one geocoder.

        Returns candidates ordered best first, each
        ``{featureId, score, label, geom, attributes}`` where ``geom``
        is always a Point, the centroid for a line or polygon match.

        ``bbox`` as ``(west, south, east, north)`` biases and restricts
        the search. The server caps results at 50.

        Note this searches whatever the geocoder was configured over:
        the org's own address layer, or an external locator. It is not
        a global street-address service unless somebody set one up.
        """
        params: Dict[str, Any] = {"text": text}
        if bbox is not None:
            params["bbox"] = ",".join(str(v) for v in bbox)
        if limit is not None:
            params["limit"] = limit
        result = self._request("GET", f"/geocode/{item_id}", params=params)
        if isinstance(result, dict):
            found = result.get("candidates")
            return found if isinstance(found, list) else []
        return []

    # ---------------------------------------------------------------
    # importing a file
    # ---------------------------------------------------------------

    def import_file(
        self,
        item_id: str,
        layer: str,
        path: Union[str, "os.PathLike[str]"],
        *,
        mode: str = "append",
        source_layer: Optional[str] = None,
        progress: Optional[Any] = None,
        timeout: float = 3600.0,
    ) -> Dict[str, Any]:
        """Load a spatial file into a layer, replacing or appending.

        This is the monthly-refresh call. Anything GDAL reads works:
        shapefile (zip it), GeoPackage, file geodatabase, GeoJSON, KML,
        GPX, CSV with coordinates, and GeoParquet.

        ``mode='replace'`` empties the layer first, which is what a
        refresh usually means. Be aware that it truncates BEFORE
        inserting, so a failure part way through leaves the layer empty
        rather than rolling back to yesterday's data. On anything you
        cannot re-import, export first.

        ``source_layer`` picks one layer out of a multi-layer archive
        like a .gdb.

        ``progress`` is called with each update as ``(processed,
        total, inserted)``, so a long import can say something::

            gg.import_file(item, "parcels", "parcels.gpkg", mode="replace",
                           progress=lambda p, t, i: print(f"{p}/{t}"))

        Returns the terminal summary: inserted, driver, sourceSrs, mode.

        The default timeout is an hour because a million-row import is a
        single request that takes as long as it takes. Files are capped
        at 1 GB by the portal.
        """
        if mode not in ("append", "replace"):
            raise ValueError("mode must be 'append' or 'replace'.")
        src = Path(path)
        params: Dict[str, Any] = {"mode": mode}
        if source_layer is not None:
            params["sourceLayer"] = source_layer
        url = f"/items/{item_id}/layers/{layer}/import"

        summary: Optional[Dict[str, Any]] = None
        failure: Optional[str] = None
        try:
            with open(src, "rb") as fh:
                with self._client.stream(
                    "POST",
                    url,
                    params=params,
                    files={"file": (src.name, fh, "application/octet-stream")},
                    timeout=httpx.Timeout(timeout, connect=10.0),
                ) as response:
                    if not response.is_success:
                        response.read()
                        self._handle(response, method="POST", path=url)
                    # The response is newline-delimited JSON, and this is
                    # the part that matters: the portal flushes 200 and
                    # its headers BEFORE it starts work, so an import
                    # that fails still arrives as a successful HTTP
                    # response with an error event in the body. Calling
                    # raise_for_status here and stopping would report a
                    # failed import as a success.
                    for line in response.iter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        kind = event.get("event")
                        if kind == "progress" and progress is not None:
                            progress(
                                event.get("processed", 0),
                                event.get("total", 0),
                                event.get("inserted", 0),
                            )
                        elif kind == "done":
                            summary = event
                        elif kind == "error":
                            failure = str(event.get("message") or "Import failed.")
        except httpx.RequestError as exc:
            raise PortalError(
                f"Could not reach the portal: {exc}", method="POST", path=url
            ) from exc

        if failure is not None:
            raise PortalError(failure, method="POST", path=url)
        if summary is None:
            # No terminal event at all: the connection died mid-import,
            # or a proxy cut it off. Not a success, and saying so beats
            # returning an empty dict that reads like one.
            raise PortalError(
                "The import ended without reporting a result. It may have "
                "partly completed; check the layer's feature count.",
                method="POST",
                path=url,
            )
        return summary

    # ---------------------------------------------------------------
    # attachments
    # ---------------------------------------------------------------

    def attachments(
        self, item_id: str, layer: str, feature_id: str
    ) -> List[Dict[str, Any]]:
        """Every file attached to one feature.

        Returns records shaped
        ``{id, fileName, mime, sizeBytes, storageUrl, createdAt, createdBy}``.
        Note ``fileName`` and ``mime``, not ``filename`` and
        ``content_type``: these are the portal's names and renaming them
        here would only mean two vocabularies to learn.

        Attachments are not carried on the feature itself, so listing
        them for a whole layer is one call per feature. That is the
        portal's shape, not an oversight of this method.
        """
        result = self._request(
            "GET",
            f"/items/{item_id}/layers/{layer}/features/{feature_id}/attachments",
        )
        return result if isinstance(result, list) else []

    def attach_file(
        self,
        item_id: str,
        layer: str,
        feature_id: str,
        path: Union[str, "os.PathLike[str]"],
        *,
        file_name: Optional[str] = None,
        content_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Attach a file to a feature.

        Three calls under the hood, because the portal never handles the
        bytes itself: ask for a presigned URL, PUT the file straight to
        object storage, then register the metadata. A 25 MB photo from a
        field crew therefore never passes through the API process.

        Needs a key WITHOUT the read-only option, and edit access to the
        item.
        """
        src = Path(path)
        data = src.read_bytes()
        name = file_name or src.name
        mime = content_type or guess_type(name)[0] or "application/octet-stream"

        presign = self._request(
            "POST",
            "/storage/presign-upload",
            json={"kind": "feature-attachment", "contentType": mime},
        )
        upload_url = presign["uploadUrl"]
        max_bytes = presign.get("maxBytes")
        # Checked here because the server does not check it. The
        # presigned PUT carries no size condition and the register call
        # believes whatever sizeBytes it is told, so without this a
        # typo uploads a gigabyte and only fails when someone notices
        # the disk. maxBytes is the deployment's own stated limit,
        # echoed back to us for exactly this purpose.
        if isinstance(max_bytes, int) and len(data) > max_bytes:
            raise ValueError(
                f"{name} is {len(data)} bytes; this portal accepts at most "
                f"{max_bytes}."
            )

        # A separate, bare client for the PUT. The portal key must not go
        # anywhere near it: the URL is signed with SigV4 and an extra
        # Authorization header invalidates the signature. The
        # Content-Type must match what we presigned with, for the same
        # reason.
        try:
            with httpx.Client(
                timeout=httpx.Timeout(300.0, connect=10.0),
                verify=self._verify_tls,
            ) as raw:
                put = raw.put(
                    upload_url, content=data, headers={"content-type": mime}
                )
        except httpx.RequestError as exc:
            raise PortalError(
                f"Could not reach object storage at {_host_of(upload_url)}: {exc}. "
                "If that host looks internal (localhost, or a container name "
                "like minio), this portal is configured for uploads from "
                "inside its own network and cannot accept them from here.",
                method="PUT",
                path=upload_url,
            ) from exc
        if not put.is_success:
            raise PortalError(
                f"Object storage refused the upload (HTTP {put.status_code}).",
                status=put.status_code,
                method="PUT",
                path=upload_url,
            )

        return self._request(
            "POST",
            f"/items/{item_id}/layers/{layer}/features/{feature_id}/attachments",
            json={
                "fileName": name,
                "mime": mime,
                "sizeBytes": len(data),
                "storageKey": presign["key"],
                "storageUrl": presign["publicUrl"],
            },
        )

    def download_attachment(
        self,
        attachment: Dict[str, Any],
        *,
        path: Optional[Union[str, "os.PathLike[str]"]] = None,
    ) -> Union[bytes, Path]:
        """Fetch one attachment, given a record from :meth:`attachments`.

        With ``path``, streams to that file and returns the
        :class:`pathlib.Path`; without it, returns the bytes. Pass a
        directory and the attachment's own ``fileName`` is used inside
        it, which is what you want when saving a whole feature's worth.
        """
        key = _attachment_key(attachment)
        url = f"/storage/private/feature-attachment/{key}"
        target: Optional[Path] = None
        if path is not None:
            target = Path(path)
            if target.is_dir():
                target = target / str(attachment.get("fileName") or key)

        try:
            with self._client.stream("GET", url) as response:
                if not response.is_success:
                    response.read()
                    self._handle(response, method="GET", path=url)
                if target is None:
                    return b"".join(response.iter_bytes())
                with open(target, "wb") as fh:
                    for chunk in response.iter_bytes():
                        fh.write(chunk)
                return target
        except httpx.RequestError as exc:
            raise PortalError(
                f"Could not reach the portal: {exc}", method="GET", path=url
            ) from exc

    def delete_attachment(
        self, item_id: str, layer: str, feature_id: str, attachment_id: str
    ) -> None:
        """Remove one attachment. Needs edit access and a writable key."""
        self._request(
            "DELETE",
            f"/items/{item_id}/layers/{layer}/features/{feature_id}"
            f"/attachments/{attachment_id}",
        )

    # ---------------------------------------------------------------
    # creating a layer
    # ---------------------------------------------------------------

    def create_data_layer(
        self,
        title: str,
        *,
        layers: Iterable[Dict[str, Any]],
        description: str = "",
        tags: Optional[Iterable[str]] = None,
        access: str = "private",
    ) -> Dict[str, Any]:
        """Create an empty data layer you can then append features to.

        One call. Layers are metadata on the observation substrate
        rather than tables to provision, so the item exists and accepts
        writes the moment this returns.

        Build the ``layers`` argument with :func:`layer` and
        :func:`field`::

            item = gg.create_data_layer(
                "Parcels within 100m of a stream",
                layers=[layer("buffered", "Buffered parcels", "polygon", [
                    field("parcel_id", "string", "Parcel ID"),
                    field("distance_m", "number", "Distance (m)"),
                ])],
            )
            gg.add_features(item["id"], "buffered", features)
        """
        payload: Dict[str, Any] = {
            "type": "data_layer",
            "title": title,
            "description": description,
            "access": access,
            "data": {
                "version": 3,
                "storageType": "postgis",
                "layers": [dict(spec) for spec in layers],
            },
        }
        if tags is not None:
            payload["tags"] = list(tags)
        if not payload["data"]["layers"]:
            raise ValueError("A data layer needs at least one layer.")
        return self._request("POST", "/items", json=payload)

    def add_layer(self, item_id: str, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Add a layer to an existing data layer item.

        There is no add-layer endpoint. A layer is added by rewriting
        the item's whole ``data`` payload, which is a footgun worth
        wrapping: ``data`` is replaced, not merged, so a hand-written
        PATCH that forgets an existing layer removes it from the schema.
        The features are not deleted, but nothing can reach them until
        the layer id comes back.

        So this reads the current schema, appends, and refuses to write
        a payload that would drop anything. It also sends
        ``expectedUpdatedAt``, which turns a concurrent edit into a 409
        rather than one of you silently overwriting the other.
        """
        item = self.item(item_id)
        if item.get("type") != "data_layer":
            raise ValueError(f"{item_id} is not a data layer.")
        data = dict(item.get("data") or {})
        if data.get("version") != 3:
            raise ValueError(
                "This item uses an older layer model that this client cannot "
                "safely edit. Add the layer in the portal instead."
            )
        existing = list(data.get("layers") or [])
        new_id = spec.get("id")
        if any(l.get("id") == new_id for l in existing):
            raise ValueError(f"This item already has a layer called {new_id!r}.")

        data["layers"] = existing + [dict(spec)]
        patch: Dict[str, Any] = {"data": data}
        # Optimistic concurrency. Cheap, and the alternative is losing
        # somebody else's layer to a read-modify-write race.
        if isinstance(item.get("updatedAt"), str):
            patch["expectedUpdatedAt"] = item["updatedAt"]
        updated = self._request("PATCH", f"/items/{item_id}", json=patch)
        self._schema_cache.pop((item_id, str(new_id)), None)
        return updated

    def add_features(
        self,
        item_id: str,
        layer: str,
        features: Iterable[Dict[str, Any]],
        *,
        batch_size: int = MAX_APPEND_BATCH,
    ) -> Dict[str, Any]:
        """Append GeoJSON features to a layer.

        Batches automatically: the portal refuses more than 5000
        features in one request, and a monthly refresh script should
        not have to know that. Returns a summary with the total count
        actually appended.

        Each feature is a GeoJSON Feature: ``{"type": "Feature",
        "geometry": {...}, "properties": {...}}``.
        """
        if batch_size < 1 or batch_size > 5000:
            raise ValueError("batch_size must be between 1 and 5000")

        total = 0
        batches = 0
        for batch in _chunks(features, batch_size):
            self._request(
                "POST",
                f"/items/{item_id}/layers/{layer}/features",
                json={"features": batch},
            )
            total += len(batch)
            batches += 1
        return {"appended": total, "batches": batches}

    def update_feature(
        self,
        item_id: str,
        layer: str,
        feature_id: str,
        *,
        geometry: Optional[Dict[str, Any]] = None,
        properties: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Update one feature. Omitted arguments are left untouched.

        The portal's substrate is an append-only observation log, so
        this records a new observation rather than mutating a row. The
        feature's history stays intact and remains queryable.
        """
        patch: Dict[str, Any] = {}
        if geometry is not None:
            patch["geometry"] = geometry
        if properties is not None:
            patch["properties"] = properties
        if not patch:
            raise ValueError("Pass geometry, properties, or both.")
        return self._request(
            "PATCH",
            f"/items/{item_id}/layers/{layer}/features/{feature_id}",
            json=patch,
        )

    def delete_feature(self, item_id: str, layer: str, feature_id: str) -> None:
        """Retire one feature. Also an observation, not a row delete."""
        self._request(
            "DELETE", f"/items/{item_id}/layers/{layer}/features/{feature_id}"
        )


def _chunks(items: Iterable[Any], size: int) -> Iterator[List[Any]]:
    """Yield fixed-size lists from any iterable, without materializing
    the whole input: a caller may hand us a generator over a very large
    source file."""
    batch: List[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
