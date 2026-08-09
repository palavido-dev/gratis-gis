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


# ---------------------------------------------------------------------
# attachments
# ---------------------------------------------------------------------

ATTACHMENT = {
    "id": "att-1",
    "fileName": "site.jpg",
    "mime": "image/jpeg",
    "sizeBytes": 9,
    "storageUrl": "/api/portal/storage/private/feature-attachment/abc-123",
    "createdAt": "2026-08-08T00:00:00.000Z",
    "createdBy": "user-1",
}


class TestAttachments:
    def test_list_returns_the_array(self):
        def handler(request):
            assert request.url.path == (
                "/api/items/itm/layers/parcels/features/f1/attachments"
            )
            return httpx.Response(200, json=[ATTACHMENT])

        got = make_client(handler).attachments("itm", "parcels", "f1")
        assert got[0]["fileName"] == "site.jpg"

    def test_upload_presigns_puts_then_registers(self, tmp_path, monkeypatch):
        src = tmp_path / "site.jpg"
        src.write_bytes(b"JPEGBYTES")
        calls = []

        def handler(request):
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/storage/presign-upload":
                body = json.loads(request.content)
                assert body == {
                    "kind": "feature-attachment",
                    "contentType": "image/jpeg",
                }
                return httpx.Response(
                    200,
                    json={
                        "uploadUrl": "https://storage.example/put?sig=x",
                        "publicUrl": "/api/portal/storage/private/feature-attachment/abc-123",
                        "key": "feature-attachment/abc-123",
                        "contentType": "image/jpeg",
                        "maxBytes": 26214400,
                    },
                )
            return httpx.Response(201, json=ATTACHMENT)

        put_seen = {}

        class FakeRaw:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def put(self, url, content=None, headers=None):
                put_seen["url"] = url
                put_seen["body"] = content
                put_seen["headers"] = dict(headers or {})
                return httpx.Response(200)

        # Build the real client BEFORE swapping httpx.Client, or the
        # patch replaces the transport this test is asserting against.
        gg = make_client(handler)
        monkeypatch.setattr(httpx, "Client", FakeRaw)
        got = gg.attach_file("itm", "parcels", "f1", src)

        assert got["id"] == "att-1"
        assert calls == [
            ("POST", "/api/storage/presign-upload"),
            ("POST", "/api/items/itm/layers/parcels/features/f1/attachments"),
        ]
        assert put_seen["body"] == b"JPEGBYTES"
        # The signed URL is signed over the content type, so it has to
        # match what was presigned.
        assert put_seen["headers"]["content-type"] == "image/jpeg"
        # And the portal key must NOT be sent: it would invalidate the
        # SigV4 signature.
        assert "authorization" not in {
            k.lower() for k in put_seen["headers"]
        }

    def test_upload_refuses_a_file_over_the_portals_limit(self, tmp_path):
        src = tmp_path / "big.bin"
        src.write_bytes(b"x" * 100)

        def handler(request):
            return httpx.Response(
                200,
                json={
                    "uploadUrl": "https://storage.example/put",
                    "publicUrl": "/api/portal/storage/private/feature-attachment/k",
                    "key": "feature-attachment/k",
                    "contentType": "application/octet-stream",
                    "maxBytes": 10,
                },
            )

        # Checked here because the server does not check it: the signed
        # PUT carries no size condition and register believes whatever
        # sizeBytes it is told.
        with pytest.raises(ValueError, match="accepts at most 10"):
            make_client(handler).attach_file("itm", "parcels", "f1", src)

    def test_download_uses_the_api_route_not_the_bff_path(self, tmp_path):
        # storageUrl points at the WEB app's proxy. Fetching it against
        # the API base would 404 in a way that looks like a missing file.
        def handler(request):
            assert request.url.path == (
                "/api/storage/private/feature-attachment/abc-123"
            )
            return httpx.Response(200, content=b"JPEGBYTES")

        assert (
            make_client(handler).download_attachment(ATTACHMENT) == b"JPEGBYTES"
        )

    def test_download_into_a_directory_uses_the_stored_name(self, tmp_path):
        def handler(request):
            return httpx.Response(200, content=b"JPEGBYTES")

        got = make_client(handler).download_attachment(ATTACHMENT, path=tmp_path)
        assert got == tmp_path / "site.jpg"
        assert got.read_bytes() == b"JPEGBYTES"

    def test_download_rejects_something_that_is_not_a_record(self):
        with pytest.raises(ValueError, match="attachment record"):
            make_client(lambda r: httpx.Response(200)).download_attachment(
                {"id": "x"}
            )

    def test_delete_hits_the_right_route(self):
        seen = {}

        def handler(request):
            seen["method"] = request.method
            seen["path"] = request.url.path
            return httpx.Response(204)

        make_client(handler).delete_attachment("itm", "parcels", "f1", "att-1")
        assert seen["method"] == "DELETE"
        assert seen["path"] == (
            "/api/items/itm/layers/parcels/features/f1/attachments/att-1"
        )


# ---------------------------------------------------------------------
# 0.5.0: delete, sharing, add_layer, calculate_field, import
# ---------------------------------------------------------------------


class TestDeleteItem:
    def test_soft_delete(self):
        seen = {}

        def handler(request):
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["params"] = dict(request.url.params)
            return httpx.Response(200)

        make_client(handler).delete_item("itm")
        assert (seen["method"], seen["path"]) == ("DELETE", "/api/items/itm")
        assert seen["params"] == {}

    def test_cascade_is_the_literal_string_true(self):
        # The server compares to 'true' exactly; ?cascade=1 is ignored.
        seen = {}

        def handler(request):
            seen.update(dict(request.url.params))
            return httpx.Response(200)

        make_client(handler).delete_item("itm", cascade=True)
        assert seen["cascade"] == "true"

    def test_folder_conflict_names_the_subfolders(self):
        def handler(request):
            return httpx.Response(
                409,
                json={
                    "message": "This folder contains subfolders...",
                    "cascade": {
                        "folders": [{"id": "f1", "title": "Surveys"}],
                        "unlinkedItemCount": 3,
                    },
                },
            )

        with pytest.raises(ConflictError, match="Surveys"):
            make_client(handler).delete_item("itm")

    def test_purge_and_restore_routes(self):
        seen = []

        def handler(request):
            seen.append((request.method, request.url.path))
            return httpx.Response(200, json={})

        gg = make_client(handler)
        gg.restore_item("itm")
        gg.purge_item("itm")
        assert seen == [
            ("POST", "/api/items/itm/restore"),
            ("DELETE", "/api/items/itm/purge"),
        ]


class TestSharing:
    def test_set_access_patches_the_item(self):
        captured = {}

        def handler(request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={})

        make_client(handler).set_access("itm", "public")
        assert captured == {"access": "public"}

    def test_set_access_rejects_an_unknown_tier(self):
        with pytest.raises(ValueError, match="Unknown access"):
            make_client(lambda r: httpx.Response(200)).set_access("itm", "world")

    def test_share_requires_a_permission(self):
        # The endpoint upserts, and omitting permission rewrites an
        # existing share down to view. Making it required beats a silent
        # downgrade.
        with pytest.raises(TypeError):
            make_client(lambda r: httpx.Response(200)).share_item(  # type: ignore[call-arg]
                "itm", user_id="u1"
            )

    def test_share_with_a_user(self):
        captured = {}

        def handler(request):
            assert request.url.path == "/api/items/itm/share"
            captured.update(json.loads(request.content))
            return httpx.Response(201, json={})

        make_client(handler).share_item("itm", user_id="u1", permission="edit")
        assert captured == {
            "principalType": "user",
            "principalId": "u1",
            "permission": "edit",
        }

    def test_share_needs_exactly_one_principal(self):
        gg = make_client(lambda r: httpx.Response(200))
        with pytest.raises(ValueError, match="exactly one"):
            gg.share_item("itm", permission="view")
        with pytest.raises(ValueError, match="exactly one"):
            gg.share_item("itm", permission="view", user_id="u", group_id="g")

    def test_unshare_sends_a_body_on_delete(self):
        captured = {}

        def handler(request):
            captured["method"] = request.method
            captured["body"] = json.loads(request.content)
            return httpx.Response(200)

        make_client(handler).unshare_item("itm", group_id="g1")
        assert captured["method"] == "DELETE"
        assert captured["body"]["principalType"] == "group"


class TestAddLayer:
    def _item(self, layers, updated="2026-08-08T00:00:00.000Z"):
        return {
            "id": "itm",
            "type": "data_layer",
            "updatedAt": updated,
            "data": {"version": 3, "storageType": "postgis", "layers": layers},
        }

    def test_appends_without_dropping_the_existing_layer(self):
        from gratisgis import layer

        captured = {}
        existing = {"id": "parcels", "label": "Parcels", "fields": []}

        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json=self._item([existing]))
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={})

        make_client(handler).add_layer(
            "itm", layer("roads", "Roads", "line", [])
        )
        ids = [l["id"] for l in captured["data"]["layers"]]
        # The whole `data` column is replaced, so a patch that forgot
        # the first layer would make its features unreachable.
        assert ids == ["parcels", "roads"]

    def test_sends_expected_updated_at(self):
        from gratisgis import layer

        captured = {}

        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json=self._item([]))
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={})

        make_client(handler).add_layer("itm", layer("a", "A", "point", []))
        assert captured["expectedUpdatedAt"] == "2026-08-08T00:00:00.000Z"

    def test_refuses_a_duplicate_layer_id(self):
        from gratisgis import layer

        def handler(request):
            return httpx.Response(
                200, json=self._item([{"id": "roads", "fields": []}])
            )

        with pytest.raises(ValueError, match="already has a layer"):
            make_client(handler).add_layer("itm", layer("roads", "R", "line", []))

    def test_refuses_a_non_v3_item(self):
        def handler(request):
            return httpx.Response(
                200,
                json={"id": "itm", "type": "data_layer", "data": {"version": 2}},
            )

        with pytest.raises(ValueError, match="older layer model"):
            make_client(handler).add_layer("itm", {"id": "x"})


class TestCalculateField:
    def test_posts_the_expression(self):
        captured = {}

        def handler(request):
            assert request.url.path == (
                "/api/items/itm/layers/parcels/features/calculate-field"
            )
            captured.update(json.loads(request.content))
            return httpx.Response(
                201,
                json={"totalRows": 10, "appliedRows": 10, "sample": [], "errors": 0},
            )

        out = make_client(handler).calculate_field(
            "itm", "parcels", "{{acres}} * 4046.86", "area_m2",
            output_type="number",
        )
        assert out["appliedRows"] == 10
        assert captured == {
            "expression": "{{acres}} * 4046.86",
            "outputName": "area_m2",
            "outputType": "number",
            "scope": "all",
            "dryRun": False,
        }

    def test_selection_scope_needs_ids(self):
        gg = make_client(lambda r: httpx.Response(200))
        with pytest.raises(ValueError, match="needs selected_ids"):
            gg.calculate_field("itm", "p", "1", "x", scope="selection")

    def test_ids_without_selection_scope_is_refused(self):
        gg = make_client(lambda r: httpx.Response(200))
        with pytest.raises(ValueError, match="only applies to"):
            gg.calculate_field("itm", "p", "1", "x", selected_ids=["a"])

    def test_rejects_an_unknown_output_type(self):
        gg = make_client(lambda r: httpx.Response(200))
        with pytest.raises(ValueError, match="output_type must be"):
            gg.calculate_field("itm", "p", "1", "x", output_type="integer")


class TestImportFile:
    def _ndjson(self, *events):
        return "\n".join(json.dumps(e) for e in events).encode()

    def test_streams_and_returns_the_done_event(self, tmp_path):
        src = tmp_path / "parcels.gpkg"
        src.write_bytes(b"GPKGDATA")
        seen = {}

        def handler(request):
            seen["params"] = dict(request.url.params)
            seen["path"] = request.url.path
            return httpx.Response(
                200,
                content=self._ndjson(
                    {"event": "start", "total": 2, "sourceLayer": "p"},
                    {"event": "progress", "processed": 1, "total": 2, "inserted": 1},
                    {"event": "done", "inserted": 2, "mode": "replace",
                     "driver": "GPKG", "sourceSrs": "EPSG:4326", "replaced": 9},
                ),
            )

        ticks = []
        out = make_client(handler).import_file(
            "itm", "parcels", src, mode="replace",
            progress=lambda p, t, i: ticks.append((p, t, i)),
        )
        assert seen["path"] == "/api/items/itm/layers/parcels/import"
        assert seen["params"]["mode"] == "replace"
        assert out["inserted"] == 2
        assert ticks == [(1, 2, 1)]

    def test_an_error_event_raises_even_though_http_is_200(self, tmp_path):
        # The portal flushes 200 and its headers before it starts work,
        # so a failed import arrives as a successful HTTP response.
        # Trusting the status code would report failure as success.
        src = tmp_path / "bad.gpkg"
        src.write_bytes(b"nope")

        def handler(request):
            return httpx.Response(
                200,
                content=self._ndjson(
                    {"event": "start", "total": 0},
                    {"event": "error", "message": "Unsupported driver."},
                ),
            )

        with pytest.raises(PortalError, match="Unsupported driver"):
            make_client(handler).import_file("itm", "parcels", src, mode="replace")

    def test_a_stream_with_no_terminal_event_is_not_a_success(self, tmp_path):
        src = tmp_path / "x.gpkg"
        src.write_bytes(b"x")

        def handler(request):
            return httpx.Response(
                200, content=self._ndjson({"event": "start", "total": 5})
            )

        with pytest.raises(PortalError, match="without reporting a result"):
            make_client(handler).import_file("itm", "parcels", src, mode="append")

    def test_mode_is_required(self, tmp_path):
        # The destructive-vs-additive choice must be explicit: a default
        # is how a refresh job silently doubles or wipes a layer.
        src = tmp_path / "x.gpkg"
        src.write_bytes(b"x")
        with pytest.raises(TypeError):
            make_client(lambda r: httpx.Response(200)).import_file(  # type: ignore[call-arg]
                "itm", "parcels", src
            )

    def test_rejects_an_unknown_mode(self, tmp_path):
        src = tmp_path / "x.gpkg"
        src.write_bytes(b"x")
        with pytest.raises(ValueError, match="mode must be"):
            make_client(lambda r: httpx.Response(200)).import_file(
                "itm", "parcels", src, mode="upsert"
            )


# ---------------------------------------------------------------------
# derived layers (server-side geometry) and geocoding
# ---------------------------------------------------------------------


class TestPipelineSteps:
    def test_fixed_buffer(self):
        from gratisgis import buffer

        assert buffer(100) == {
            "tool": "buffer",
            "params": {"mode": "fixed", "distance": 100, "unit": "meters"},
        }

    def test_buffer_by_a_field(self):
        from gratisgis import buffer

        assert buffer("setback_ft", "feet")["params"] == {
            "mode": "field",
            "field": "setback_ft",
            "unit": "feet",
        }

    def test_rejects_a_bad_unit_and_a_zero_distance(self):
        from gratisgis import buffer

        with pytest.raises(ValueError, match="Unknown unit"):
            buffer(10, "furlongs")
        with pytest.raises(ValueError, match="greater than zero"):
            buffer(0)

    def test_step_rejects_an_unknown_tool(self):
        from gratisgis import step

        with pytest.raises(ValueError, match="Unknown tool"):
            step("intersect")          # the portal calls it clip
        assert step("dissolve", fields=["county"]) == {
            "tool": "dissolve",
            "params": {"fields": ["county"]},
        }


class TestDerivedLayers:
    def test_preview_sends_only_the_allowed_keys(self):
        from gratisgis import buffer

        captured = {}

        def handler(request):
            assert request.url.path == "/api/items/derived-layer:preview"
            captured.update(json.loads(request.content))
            return httpx.Response(201, json={"features": []})

        make_client(handler).preview_pipeline("src", "parcels", [buffer(100)])
        # This endpoint validates strictly: an extra key is a 400, not an
        # ignored field.
        assert set(captured) == {"source", "pipeline", "limit"}
        assert captured["source"] == {
            "kind": "data_layer",
            "itemId": "src",
            "layerKey": "parcels",
        }

    def test_create_builds_a_recipe_item(self):
        from gratisgis import buffer, step

        captured = {}

        def handler(request):
            assert request.url.path == "/api/items"
            captured.update(json.loads(request.content))
            return httpx.Response(201, json={"id": "derived-1"})

        make_client(handler).create_derived_layer(
            "Parcels within 100m of a stream",
            "src",
            "parcels",
            [buffer(100), step("dissolve", fields=["county"])],
        )
        assert captured["type"] == "derived_layer"
        assert captured["data"]["version"] == 1
        assert [s["tool"] for s in captured["data"]["pipeline"]] == [
            "buffer",
            "dissolve",
        ]

    def test_an_empty_pipeline_is_refused(self):
        gg = make_client(lambda r: httpx.Response(200))
        with pytest.raises(ValueError, match="at least one step"):
            gg.create_derived_layer("t", "src", "parcels", [])
        with pytest.raises(ValueError, match="at least one step"):
            gg.preview_pipeline("src", "parcels", [])


class TestGeocoding:
    def test_geocode_unwraps_candidates(self):
        def handler(request):
            assert request.url.path == "/api/geocode/geo-1"
            assert dict(request.url.params)["text"] == "12 Main St"
            return httpx.Response(
                200, json={"candidates": [{"label": "12 Main St", "score": 91}]}
            )

        out = make_client(handler).geocode("geo-1", "12 Main St")
        assert out[0]["score"] == 91

    def test_bbox_is_comma_joined(self):
        seen = {}

        def handler(request):
            seen.update(dict(request.url.params))
            return httpx.Response(200, json={"candidates": []})

        make_client(handler).geocode(
            "geo-1", "x", bbox=(-80.1, 38.7, -80.0, 38.8), limit=5
        )
        assert seen["bbox"] == "-80.1,38.7,-80.0,38.8"
        assert seen["limit"] == "5"

    def test_find_geocoders_filters_by_type(self):
        seen = {}

        def handler(request):
            seen.update(dict(request.url.params))
            return httpx.Response(200, json=[])

        make_client(handler).find_geocoders()
        # There is no portal-wide geocoder; each one is an item, so
        # discovery is a normal item search.
        assert seen["type"] == "geocoding_service"
