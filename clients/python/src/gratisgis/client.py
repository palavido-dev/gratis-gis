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
from typing import Any, Dict, Iterable, Iterator, List, Optional

import httpx

from .errors import (
    AuthError,
    ConflictError,
    NotFoundError,
    PortalError,
    RateLimitError,
    ValidationError,
)

__all__ = ["GratisGIS"]

# The portal caps a single append at 5000 features (AppendFeaturesBodyDto).
# Batch below it so a caller handing us a million rows just works.
MAX_APPEND_BATCH = 1000


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
        user_agent: str = "gratisgis-python/0.1.0",
        client: Optional[httpx.Client] = None,
    ) -> None:
        if not api_key:
            raise ValueError(
                "An API key is required. Create one at Profile -> API keys "
                "in the portal, or use GratisGIS.from_env()."
            )
        self.portal_url = portal_url.rstrip("/")
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
            params["query"] = query
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

    def read_features(
        self,
        item_id: str,
        layer: str,
        *,
        limit: Optional[int] = None,
        bbox: Optional[Iterable[float]] = None,
        cursor: Optional[str] = None,
        at: Optional[str] = None,
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
        return self._request(
            "GET", f"/items/{item_id}/layers/{layer}/geojson", params=params
        )

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
