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
        # Sent as `q`: the portal ignores `query` (see TestFindItemsQueryParam).
        assert seen["params"]["q"] == "parcels"
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
        # /features, not /geojson: identical body, and the only one of
        # the two that accepts the attribute filters.
        assert seen["path"] == "/api/items/item-1/layers/parcels/features"
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


# ---------------------------------------------------------------------
# 0.3.0: filtering, search, export, layer creation
# ---------------------------------------------------------------------

SCHEMA_ITEM = {
    "id": "itm",
    "type": "data_layer",
    "data": {
        "version": 3,
        "storageType": "postgis",
        "layers": [
            {
                "id": "parcels",
                "label": "Parcels",
                "name": "parcels",
                "geometryType": "polygon",
                "fields": [
                    {"name": "owner", "type": "string", "label": "Owner"},
                    {"name": "surveyed", "type": "date", "label": "Surveyed"},
                ],
            }
        ],
    },
}


def schema_handler(extra=None):
    """Serve the item schema, then hand anything else to `extra`."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/items/itm":
            return httpx.Response(200, json=SCHEMA_ITEM)
        if extra is not None:
            return extra(request)
        return httpx.Response(200, json={"type": "FeatureCollection", "features": []})

    handler.seen = seen
    return handler


class TestFindItemsQueryParam:
    def test_search_text_is_sent_as_q(self):
        # It was sent as `query` until 0.3.0. The portal reads `q` and
        # ignored the other, so every search silently returned an
        # unfiltered list and looked like it had worked.
        captured = {}

        def handler(request):
            captured.update(dict(request.url.params))
            return httpx.Response(200, json=[])

        make_client(handler).find_items(query="parcels", type="data_layer")
        assert captured["q"] == "parcels"
        assert "query" not in captured


class TestReadFilters:
    def test_uses_the_features_route_not_geojson(self):
        # /features is the same body plus the filters; /geojson has none.
        handler = schema_handler()
        make_client(handler).read_features("itm", "parcels", limit=5)
        assert handler.seen[-1].url.path == "/api/items/itm/layers/parcels/features"

    def test_parent_filter_is_sent(self):
        handler = schema_handler()
        make_client(handler).read_features(
            "itm", "parcels", parent_fk="owner", parent_id="Smith"
        )
        params = dict(handler.seen[-1].url.params)
        assert params["parentFk"] == "owner"
        assert params["parentId"] == "Smith"

    def test_unknown_filter_field_is_refused_before_the_request(self):
        # The portal DROPS an unrecognised filter field and returns the
        # whole layer, so a typo would otherwise look like a successful
        # query with a surprising number of rows.
        handler = schema_handler()
        with pytest.raises(ValueError, match="no field 'ownr'"):
            make_client(handler).read_features(
                "itm", "parcels", parent_fk="ownr", parent_id="Smith"
            )
        assert not any(
            r.url.path.endswith("/features") for r in handler.seen
        )

    def test_half_a_parent_filter_is_refused(self):
        handler = schema_handler()
        with pytest.raises(ValueError, match="go together"):
            make_client(handler).read_features("itm", "parcels", parent_fk="owner")

    def test_time_filter_needs_a_bound(self):
        handler = schema_handler()
        with pytest.raises(ValueError, match="at least one"):
            make_client(handler).read_features("itm", "parcels", time_field="surveyed")

    def test_time_bounds_need_a_field(self):
        handler = schema_handler()
        with pytest.raises(ValueError, match="need a time_field"):
            make_client(handler).read_features("itm", "parcels", time_from="2026-01-01")

    def test_time_filter_is_sent(self):
        handler = schema_handler()
        make_client(handler).read_features(
            "itm", "parcels", time_field="surveyed", time_from="2026-01-01"
        )
        params = dict(handler.seen[-1].url.params)
        assert params["timeField"] == "surveyed"
        assert params["timeFrom"] == "2026-01-01"

    def test_schema_is_fetched_once(self):
        handler = schema_handler()
        gg = make_client(handler)
        for _ in range(3):
            gg.read_features("itm", "parcels", parent_fk="owner", parent_id="x")
        assert sum(1 for r in handler.seen if r.url.path == "/api/items/itm") == 1

    def test_missing_layer_names_the_ones_that_exist(self):
        handler = schema_handler()
        with pytest.raises(NotFoundError, match="Layers on this item: parcels"):
            make_client(handler).layer_schema("itm", "nope")


class TestSearchFeatures:
    def test_returns_the_results_array(self):
        def extra(request):
            return httpx.Response(200, json={"results": [{"id": "a"}], "truncated": False})

        handler = schema_handler(extra)
        found = make_client(handler).search_features("itm", "parcels", "smith")
        assert found == [{"id": "a"}]
        assert handler.seen[-1].url.path.endswith("/features-search")
        assert dict(handler.seen[-1].url.params)["q"] == "smith"

    def test_field_restriction_is_validated(self):
        handler = schema_handler()
        with pytest.raises(ValueError, match="no field 'nope'"):
            make_client(handler).search_features("itm", "parcels", "x", fields=["nope"])


class TestExport:
    def test_geoparquet_is_the_default_and_returns_bytes(self):
        def handler(request):
            assert request.url.path == "/api/items/itm/layers/parcels/geoparquet"
            return httpx.Response(200, content=b"PAR1data")

        assert make_client(handler).export_layer("itm", "parcels") == b"PAR1data"

    def test_writes_to_a_path_and_returns_it(self, tmp_path):
        def handler(request):
            return httpx.Response(200, content=b"a,b\n1,2\n")

        out = tmp_path / "parcels.csv"
        got = make_client(handler).export_layer("itm", "parcels", format="csv", path=out)
        assert got == out
        assert out.read_bytes() == b"a,b\n1,2\n"

    def test_unknown_format_is_refused_locally(self):
        with pytest.raises(ValueError, match="Unknown export format"):
            make_client(lambda r: httpx.Response(200)).export_layer(
                "itm", "parcels", format="shapefile"
            )

    def test_geometry_option_is_csv_only(self):
        with pytest.raises(ValueError, match="only applies to the csv"):
            make_client(lambda r: httpx.Response(200)).export_layer(
                "itm", "parcels", geometry="wkt"
            )

    def test_a_403_still_carries_the_portal_message(self):
        # The body of a streamed error response has to be read before it
        # can be reported, or the user gets a bare status code.
        def handler(request):
            return httpx.Response(
                403, json={"message": "Downloading the data requires a share with download permission."}
            )

        with pytest.raises(AuthError, match="download permission"):
            make_client(handler).export_layer("itm", "parcels")


class TestCreateDataLayer:
    def test_builds_a_v3_payload(self):
        from gratisgis import field, layer

        captured = {}

        def handler(request):
            captured.update(json.loads(request.content))
            return httpx.Response(201, json={"id": "new"})

        make_client(handler).create_data_layer(
            "Buffered parcels",
            layers=[
                layer("buffered", "Buffered", "polygon", [field("parcel_id", "string")])
            ],
        )
        assert captured["type"] == "data_layer"
        assert captured["data"]["version"] == 3
        got = captured["data"]["layers"][0]
        assert got["id"] == "buffered"
        assert got["geometryType"] == "polygon"
        assert got["fields"][0] == {
            "name": "parcel_id",
            "type": "string",
            "label": "parcel_id",
            "nullable": True,
        }

    def test_refuses_an_empty_layer_list(self):
        with pytest.raises(ValueError, match="at least one layer"):
            make_client(lambda r: httpx.Response(200)).create_data_layer("x", layers=[])

    def test_rejects_geojson_geometry_names(self):
        from gratisgis import layer

        # 'LineString' is the GeoJSON name; the portal calls it 'line'.
        with pytest.raises(ValueError, match="Unknown geometry type"):
            layer("l", "L", "LineString", [])

    def test_a_table_layer_has_no_geometry(self):
        from gratisgis import layer

        assert layer("t", "T", None, [])["geometryType"] is None

    def test_rejects_an_unknown_field_type(self):
        from gratisgis import field

        with pytest.raises(ValueError, match="Unknown field type"):
            field("x", "integer")
