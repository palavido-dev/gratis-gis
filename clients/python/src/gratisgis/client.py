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

__all__ = ["GratisGIS", "field", "layer"]

# Declared here rather than in __init__, which imports this module:
# the default User-Agent below needs it, and a second literal would
# drift from the package version the first time one of them is bumped
# alone.
__version__ = "0.4.0"

# The portal caps a single append at 5000 features (AppendFeaturesBodyDto).
# Batch below it so a caller handing us a million rows just works.
MAX_APPEND_BATCH = 1000

#: Field types a layer may declare. Mirrors FeatureFieldType in
#: packages/shared-types/src/data-layer.ts.
FIELD_TYPES = ("string", "number", "boolean", "date", "multi_select")

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
        """Sparse update. Only the keys present are changed."""
        return self._request("PATCH", f"/items/{item_id}", json=patch)

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
