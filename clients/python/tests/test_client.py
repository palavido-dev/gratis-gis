# SPDX-License-Identifier: AGPL-3.0-or-later
"""Client tests against a mock transport: no portal required.

httpx.MockTransport lets us assert the exact request the client makes
(path, params, body) as well as how it handles each response, which is
the part that actually breaks in the field.
"""

from __future__ import annotations

import json

import httpx
import pytest

from gratisgis import (
    AuthError,
    ConflictError,
    GratisGIS,
    NotFoundError,
    PortalError,
    RateLimitError,
    ValidationError,
)


def make_client(handler) -> GratisGIS:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(
        base_url="https://portal.example/api",
        transport=transport,
        headers={"Authorization": "Bearer ggk_test"},
    )
    return GratisGIS("https://portal.example", api_key="ggk_test", client=inner)


class TestConstruction:
    def test_requires_a_key(self):
        with pytest.raises(ValueError, match="API key is required"):
            GratisGIS("https://portal.example", api_key="")

    def test_from_env_reports_every_missing_variable(self, monkeypatch):
        monkeypatch.delenv("GRATISGIS_URL", raising=False)
        monkeypatch.delenv("GRATISGIS_API_KEY", raising=False)
        with pytest.raises(ValueError) as err:
            GratisGIS.from_env()
        assert "GRATISGIS_URL" in str(err.value)
        assert "GRATISGIS_API_KEY" in str(err.value)

    def test_from_env_builds_a_client(self, monkeypatch):
        monkeypatch.setenv("GRATISGIS_URL", "https://portal.example/")
        monkeypatch.setenv("GRATISGIS_API_KEY", "ggk_env")
        gg = GratisGIS.from_env()
        # Trailing slash normalized so URL joins stay predictable.
        assert gg.portal_url == "https://portal.example"
        gg.close()

    def test_sends_the_key_as_a_bearer_token(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json={"id": "u1"})

        # Build without injecting a client so the real headers apply.
        transport = httpx.MockTransport(handler)
        gg = GratisGIS(
            "https://portal.example",
            api_key="ggk_secret",
            client=httpx.Client(
                base_url="https://portal.example/api",
                transport=transport,
                headers={"Authorization": "Bearer ggk_secret"},
            ),
        )
        gg.whoami()
        assert seen["auth"] == "Bearer ggk_secret"


class TestItems:
    def test_find_items_passes_filters_through(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["params"] = dict(request.url.params)
            return httpx.Response(200, json=[{"id": "i1"}])

        items = make_client(handler).find_items(
            type="data_layer", query="parcels", limit=5, full=True
        )
        assert seen["path"] == "/api/items"
        assert seen["params"]["type"] == "data_layer"
        assert seen["params"]["query"] == "parcels"
        assert seen["params"]["limit"] == "5"
        assert seen["params"]["full"] == "1"
        assert items == [{"id": "i1"}]

    def test_find_items_tolerates_a_wrapped_envelope(self):
        def handler(_r):
            return httpx.Response(200, json={"items": [{"id": "i2"}]})

        assert make_client(handler).find_items() == [{"id": "i2"}]

    def test_item_unwraps_an_envelope(self):
        def handler(_r):
            return httpx.Response(200, json={"item": {"id": "i3"}})

        assert make_client(handler).item("i3")["id"] == "i3"


class TestFeatures:
    def test_read_features_builds_the_layer_path_and_bbox(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["params"] = dict(request.url.params)
            return httpx.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )

        make_client(handler).read_features(
            "item-1", "parcels", limit=10, bbox=[-80.1, 38.7, -80.0, 38.8]
        )
        assert seen["path"] == "/api/items/item-1/layers/parcels/geojson"
        assert seen["params"]["limit"] == "10"
        assert seen["params"]["bbox"] == "-80.1,38.7,-80.0,38.8"

    def test_iter_features_yields_each_feature(self):
        def handler(_r):
            return httpx.Response(
                200,
                json={
                    "type": "FeatureCollection",
                    "features": [{"id": 1}, {"id": 2}, {"id": 3}],
                },
            )

        out = list(make_client(handler).iter_features("i", "l"))
        assert [f["id"] for f in out] == [1, 2, 3]

    def test_iter_features_follows_the_cursor_to_the_end(self):
        """The whole point of the method: a layer bigger than one page
        must come back whole, not truncated at the first response."""
        pages = {
            None: {"features": [{"id": 1}, {"id": 2}], "nextCursor": "c1"},
            "c1": {"features": [{"id": 3}, {"id": 4}], "nextCursor": "c2"},
            "c2": {"features": [{"id": 5}], "nextCursor": None},
        }
        seen_cursors = []

        def handler(request: httpx.Request) -> httpx.Response:
            cursor = request.url.params.get("cursor")
            seen_cursors.append(cursor)
            page = pages[cursor]
            return httpx.Response(
                200, json={"type": "FeatureCollection", "asOf": "T0", **page}
            )

        out = list(make_client(handler).iter_features("i", "l", page_size=2))
        assert [f["id"] for f in out] == [1, 2, 3, 4, 5]
        assert seen_cursors == [None, "c1", "c2"]

    def test_iter_features_does_not_stop_on_an_empty_page(self):
        """Deleted rows still occupy a page slot server-side, so a page
        can be empty with more data behind it. Stopping there would
        silently drop the rest of the layer."""
        pages = {
            None: {"features": [{"id": 1}], "nextCursor": "c1"},
            "c1": {"features": [], "nextCursor": "c2"},
            "c2": {"features": [{"id": 2}], "nextCursor": None},
        }

        def handler(request: httpx.Request) -> httpx.Response:
            page = pages[request.url.params.get("cursor")]
            return httpx.Response(
                200, json={"type": "FeatureCollection", "asOf": "T0", **page}
            )

        out = list(make_client(handler).iter_features("i", "l", page_size=1))
        assert [f["id"] for f in out] == [1, 2]

    def test_iter_features_pins_the_snapshot_after_the_first_page(self):
        """Every page after the first must carry the first page's asOf,
        or a feature written mid-walk can be missed."""
        seen_at = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_at.append(request.url.params.get("at"))
            done = request.url.params.get("cursor") == "c1"
            return httpx.Response(
                200,
                json={
                    "type": "FeatureCollection",
                    "features": [{"id": 1}],
                    "nextCursor": None if done else "c1",
                    "asOf": "2026-08-05T00:00:00.000Z",
                },
            )

        list(make_client(handler).iter_features("i", "l"))
        assert seen_at == [None, "2026-08-05T00:00:00.000Z"]

    def test_iter_features_still_works_against_a_portal_without_paging(self):
        """An older portal ignores limit/cursor and returns everything
        with no nextCursor. That must terminate after one page rather
        than loop or raise."""
        calls = []

        def handler(_r):
            calls.append(1)
            return httpx.Response(
                200,
                json={
                    "type": "FeatureCollection",
                    "features": [{"id": 1}, {"id": 2}],
                },
            )

        out = list(make_client(handler).iter_features("i", "l"))
        assert [f["id"] for f in out] == [1, 2]
        assert len(calls) == 1

    def test_add_features_batches_under_the_portal_cap(self):
        """The portal refuses >5000 per request; a caller handing us
        2500 with batch_size=1000 must transparently become 3 calls."""
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(len(json.loads(request.content)["features"]))
            return httpx.Response(201, json={"inserted": 0})

        feats = [{"type": "Feature", "properties": {"n": i}} for i in range(2500)]
        result = make_client(handler).add_features("i", "l", feats, batch_size=1000)
        assert calls == [1000, 1000, 500]
        assert result == {"appended": 2500, "batches": 3}

    def test_add_features_accepts_a_generator_without_materializing(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(len(json.loads(request.content)["features"]))
            return httpx.Response(201, json={})

        gen = ({"type": "Feature", "properties": {"n": i}} for i in range(5))
        assert make_client(handler).add_features("i", "l", gen, batch_size=2)[
            "appended"
        ] == 5
        assert calls == [2, 2, 1]

    def test_add_features_rejects_a_batch_size_the_portal_would_refuse(self):
        gg = make_client(lambda _r: httpx.Response(201, json={}))
        for bad in (0, 5001):
            with pytest.raises(ValueError, match="between 1 and 5000"):
                gg.add_features("i", "l", [], batch_size=bad)

    def test_add_features_makes_no_call_for_an_empty_iterable(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(201, json={})

        assert make_client(handler).add_features("i", "l", [])["batches"] == 0
        assert calls == []

    def test_update_feature_sends_only_what_changed(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            seen["method"] = request.method
            return httpx.Response(200, json={})

        make_client(handler).update_feature(
            "i", "l", "f1", properties={"status": "done"}
        )
        assert seen["method"] == "PATCH"
        assert seen["body"] == {"properties": {"status": "done"}}

    def test_update_feature_requires_something_to_change(self):
        gg = make_client(lambda _r: httpx.Response(200, json={}))
        with pytest.raises(ValueError, match="geometry, properties, or both"):
            gg.update_feature("i", "l", "f1")

    def test_delete_feature_tolerates_204_with_no_body(self):
        assert (
            make_client(lambda _r: httpx.Response(204)).delete_feature("i", "l", "f")
            is None
        )


class TestErrorMapping:
    @pytest.mark.parametrize(
        "status,expected",
        [
            (401, AuthError),
            (403, AuthError),
            (404, NotFoundError),
            (409, ConflictError),
            (400, ValidationError),
            (422, ValidationError),
            (500, PortalError),
        ],
    )
    def test_status_maps_to_the_right_type(self, status, expected):
        gg = make_client(
            lambda _r: httpx.Response(status, json={"message": "nope"})
        )
        with pytest.raises(expected) as err:
            gg.whoami()
        assert err.value.status == status

    def test_surfaces_the_portals_own_message(self):
        """The portal writes user-facing copy on purpose; a client that
        replaces it with 'HTTP 403' throws away the useful part."""
        gg = make_client(
            lambda _r: httpx.Response(
                403,
                json={
                    "message": "This API key is read-only. Create a key without the read-only option to make changes."
                },
            )
        )
        with pytest.raises(AuthError) as err:
            gg.whoami()
        assert "read-only" in str(err.value)

    def test_rate_limit_carries_retry_after(self):
        gg = make_client(
            lambda _r: httpx.Response(429, json={}, headers={"retry-after": "30"})
        )
        with pytest.raises(RateLimitError) as err:
            gg.whoami()
        assert err.value.retry_after == 30

    def test_falls_back_to_body_text_when_not_json(self):
        gg = make_client(lambda _r: httpx.Response(502, text="upstream is down"))
        with pytest.raises(PortalError, match="upstream is down"):
            gg.whoami()

    def test_network_failure_is_a_portal_error_not_an_httpx_error(self):
        def handler(_r):
            raise httpx.ConnectError("no route to host")

        with pytest.raises(PortalError, match="Could not reach the portal"):
            make_client(handler).whoami()

    def test_error_str_includes_status_and_route(self):
        gg = make_client(lambda _r: httpx.Response(404, json={"message": "gone"}))
        with pytest.raises(NotFoundError) as err:
            gg.item("missing")
        text = str(err.value)
        assert "gone" in text and "404" in text and "/items/missing" in text


def test_context_manager_closes_an_owned_client():
    with GratisGIS("https://portal.example", api_key="ggk_x") as gg:
        assert gg.portal_url == "https://portal.example"
    assert gg._client.is_closed
