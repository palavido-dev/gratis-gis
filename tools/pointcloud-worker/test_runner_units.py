# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit checks for runner.py's pure helpers (cancel predicate and
the streaming contours transform). Plain-assert style so it runs
anywhere with `python3 test_runner_units.py` and needs no test
framework; `python3 -m pytest test_runner_units.py` also works.

boto3/psycopg2 are stubbed before import because these tests only
exercise pure functions, and requiring the worker's conda image
just to import the module would keep this from running in CI or on
a dev laptop.
"""

import json
import sys
import tempfile
import types
from pathlib import Path

for name in ("boto3", "psycopg2", "psycopg2.extras"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["psycopg2"].extras = sys.modules["psycopg2.extras"]

sys.path.insert(0, str(Path(__file__).parent))
import runner  # noqa: E402


def test_is_cancel_requested():
    assert runner.is_cancel_requested("cancel_requested") is True
    for other in ("queued", "running", "cancelled", "failed", "done", None, 7):
        assert runner.is_cancel_requested(other) is False


def test_add_feet_field():
    f = {"type": "Feature", "properties": {"elevation_m": 100}}
    runner.add_feet_field(f)
    assert f["properties"]["elevation_ft"] == 328.1
    # Missing properties object: created, no feet added, no crash.
    bare = {"type": "Feature"}
    runner.add_feet_field(bare)
    assert bare["properties"] == {}
    # Null / boolean elevations (nodata edges) never produce feet.
    weird = {"type": "Feature", "properties": {"elevation_m": None}}
    runner.add_feet_field(weird)
    assert "elevation_ft" not in weird["properties"]
    boolish = {"type": "Feature", "properties": {"elevation_m": True}}
    runner.add_feet_field(boolish)
    assert "elevation_ft" not in boolish["properties"]


def _feature(ele):
    return {
        "type": "Feature",
        "properties": {"elevation_m": ele},
        "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
    }


def test_stream_contours_with_feet():
    with tempfile.TemporaryDirectory() as td:
        seq = Path(td) / "in.geojsonl"
        out = Path(td) / "out.geojson"
        lines = [json.dumps(_feature(e)) for e in (10, 20.5, 30)]
        # Second line carries the RFC 8142 RS prefix and there is a
        # blank line: both must be tolerated.
        lines[1] = "\x1e" + lines[1]
        seq.write_text("\n".join([lines[0], "", lines[1], lines[2]]) + "\n")

        count = runner.stream_contours_with_feet(seq, out)
        assert count == 3

        doc = json.loads(out.read_text())
        assert doc["type"] == "FeatureCollection"
        assert len(doc["features"]) == 3
        feet = [f["properties"]["elevation_ft"] for f in doc["features"]]
        assert feet == [32.8, 67.3, 98.4]
        # Geometry must round-trip untouched.
        assert doc["features"][0]["geometry"]["coordinates"] == [[0, 0], [1, 1]]


def test_stream_contours_empty_input():
    with tempfile.TemporaryDirectory() as td:
        seq = Path(td) / "in.geojsonl"
        out = Path(td) / "out.geojson"
        seq.write_text("")
        assert runner.stream_contours_with_feet(seq, out) == 0
        # Even an empty result is a valid (empty) FeatureCollection.
        doc = json.loads(out.read_text())
        assert doc == {"type": "FeatureCollection", "features": []}


def test_reclaim_abandoned_scratch():
    """#206: a dir whose job is dead goes, an alive job's dir and a
    dir the worker does not recognize both stay."""
    # The except in the function needs a real exception type on the
    # psycopg2 stub.
    sys.modules["psycopg2"].Error = RuntimeError

    class Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, _q, params):
            self.last = params[0]

        def fetchone(self):
            return (1,) if self.last == "alive" else None

    class Conn:
        def cursor(self):
            return Cur()

        def commit(self):
            pass

        def rollback(self):
            pass

    with tempfile.TemporaryDirectory() as td:
        scratch = Path(td)
        old = runner.SCRATCH
        runner.SCRATCH = scratch
        try:
            (scratch / "job-alive").mkdir()
            (scratch / "job-dead").mkdir()
            (scratch / "copc-dead2").mkdir()
            (scratch / "mosaic-dead3").mkdir()
            (scratch / "unrelated").mkdir()
            removed = runner.reclaim_abandoned_scratch(Conn())
            left = sorted(p.name for p in scratch.iterdir())
            assert removed == 3, removed
            assert left == ["job-alive", "unrelated"], left
        finally:
            runner.SCRATCH = old


def test_plan_grid_chunks_single_when_under_budget():
    """A small extent returns one un-buffered chunk, i.e. exactly
    the pre-#208 behavior."""
    chunks = runner.plan_grid_chunks(0, 0, 100, 100, 1.0, 64_000_000, 8)
    assert len(chunks) == 1, chunks
    assert chunks[0]["core"] == chunks[0]["buffered"] == (0, 0, 100, 100)


def test_plan_grid_chunks_tiles_exactly():
    """#208: cores tile the extent with no gaps, no overlaps, all
    edges on the resolution lattice, and every buffered tile inside
    the cell budget."""
    minx, miny, maxx, maxy = 100.0, 200.0, 100.0 + 3000, 200.0 + 2500
    res = 1.0
    budget = 1_000_000  # forces chunking: 3000x2500 = 7.5M cells
    buffer_cells = 8
    chunks = runner.plan_grid_chunks(
        minx, miny, maxx, maxy, res, budget, buffer_cells
    )
    assert len(chunks) > 1
    area = 0.0
    for ch in chunks:
        cx0, cy0, cx1, cy1 = ch["core"]
        bx0, by0, bx1, by1 = ch["buffered"]
        # Alignment: core edges sit on the lattice anchored at
        # (minx, miny), so chunk rasters share one global grid.
        assert abs(((cx0 - minx) / res) - round((cx0 - minx) / res)) < 1e-9
        assert abs(((cy0 - miny) / res) - round((cy0 - miny) / res)) < 1e-9
        # Buffer contains the core and stays inside the extent.
        assert bx0 <= cx0 and by0 <= cy0 and bx1 >= cx1 and by1 >= cy1
        assert bx0 >= minx and by0 >= miny and bx1 <= maxx and by1 <= maxy
        # Buffered tile respects the cell budget.
        cells = ((bx1 - bx0) / res) * ((by1 - by0) / res)
        assert cells <= budget, cells
        area += (cx1 - cx0) * (cy1 - cy0)
    # Cores cover the extent exactly (area equality + pairwise
    # disjointness follows from the regular grid construction).
    assert abs(area - (maxx - minx) * (maxy - miny)) < 1e-6, area
    # No two cores overlap.
    cores = [c["core"] for c in chunks]
    for i in range(len(cores)):
        for j in range(i + 1, len(cores)):
            a, b = cores[i], cores[j]
            assert not (
                a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]
            ), (a, b)


def test_plan_grid_chunks_elkins_shape():
    """The motivating case: ~30.7km x 13.5km at 1m is ~414M cells,
    2.9x over the old cap; it must plan to a sane chunk count with
    full coverage."""
    chunks = runner.plan_grid_chunks(
        0, 0, 30_700, 13_500, 1.0, 64_000_000, 8
    )
    assert 1 < len(chunks) <= 24, len(chunks)
    area = sum(
        (c["core"][2] - c["core"][0]) * (c["core"][3] - c["core"][1])
        for c in chunks
    )
    assert abs(area - 30_700 * 13_500) < 1e-3


def test_pdal_bounds_str():
    """Takes a (minx, miny, maxx, maxy) BOX and interleaves it into
    PDAL's ([xmin, xmax], [ymin, ymax]) shape; the box-not-args
    signature exists because an arg swap here cost a prod run."""
    assert runner.pdal_bounds_str((1, 2, 3, 4)) == "([1, 3], [2, 4])"
    chunk = runner.plan_grid_chunks(0, 0, 100, 100, 1.0, 64_000_000, 8)[0]
    assert runner.pdal_bounds_str(chunk["buffered"]) == (
        "([0, 100], [0, 100])"
    )


def test_compute_zonal_stats_arrays():
    values = [1.0, 2.0, 3.0, float("nan"), 10.0, 20.0]
    fids = [1, 1, 1, 1, 2, 0]
    out = runner.compute_zonal_stats_arrays(
        values, fids, ["mean", "min", "max", "sum", "count"]
    )
    assert out[1]["count"] == 3
    assert out[1]["mean"] == 2.0
    assert out[1]["min"] == 1.0
    assert out[1]["max"] == 3.0
    assert out[1]["sum"] == 6.0
    assert out[2]["count"] == 1
    assert out[2]["mean"] == 10.0
    assert 0 not in out


def test_finish_job_keeps_the_lease():
    class Cursor:
        def __init__(self):
            self.sql = ""
            self.args = None

        def execute(self, sql, args):
            self.sql = sql
            self.args = args
            self.rowcount = 1

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    class Conn:
        def __init__(self):
            self.cur = Cursor()
            self.commits = 0

        def cursor(self):
            return self.cur

        def commit(self):
            self.commits += 1

    conn = Conn()
    token = "11111111-1111-1111-1111-111111111111"
    assert runner.finish_job(conn, "job-1", None, token) is True
    assert "state IN ('running', 'cancel_requested')" in conn.cur.sql
    assert "claim_token = %s::uuid" in conn.cur.sql
    assert "IS NULL" not in conn.cur.sql
    assert conn.cur.args == ("job-1", token)
    assert conn.commits == 1
    refused = Conn()
    assert runner.finish_job(refused, "job-2", "boom", None) is False
    assert refused.cur.args is None
    runner.remember_lease("job-3", token)
    beat = Conn()
    try:
        runner.set_progress(beat, "job-3", 10)
    except Exception:
        pass
    assert "claim_token = %s::uuid" in beat.cur.sql


def test_merge_item_data_checks_the_lease_in_the_write():
    class Cursor:
        def __init__(self):
            self.sql = ""
            self.rowcount = 0

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def execute(self, sql, _args=None):
            self.sql += "\n" + sql
            if "UPDATE item" in sql:
                self.rowcount = 0

    class Conn:
        def __init__(self):
            self.cur = Cursor()
            self.commits = 0
            self.rolled = 0

        def cursor(self):
            return self.cur

        def commit(self):
            self.commits += 1

        def rollback(self):
            self.rolled += 1

    token = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    runner.remember_lease("job-pub", token)
    runner._current_job_id = "job-pub"
    conn = Conn()
    try:
        raised = False
        try:
            runner.merge_item_data(conn, "item-1", {"processingState": "ready"})
        except runner.JobLost:
            raised = True
        assert raised
        assert "FOR UPDATE" in conn.cur.sql
        assert "UPDATE item" in conn.cur.sql
        assert "EXISTS (SELECT 1 FROM held)" in conn.cur.sql
        assert conn.rolled == 1
        assert conn.commits == 0
    finally:
        runner._current_job_id = None


class _JobDb:
    """Just enough of analysis_job + item for the settle order: the
    item merge only lands while the job is still live, as in SQL."""

    def __init__(self):
        self.state = "running"
        self.item_patches = []
        self.commits = 0
        self.rolled = 0

    def cursor(self):
        db = self

        class Cursor:
            rowcount = 0

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def execute(self, sql, args=None):
                self.rowcount = 0
                if "UPDATE item" in sql:
                    if db.state in ("running", "cancel_requested"):
                        db.item_patches.append(json.loads(args[2]))
                        self.rowcount = 1
                elif "UPDATE analysis_job" in sql and db.state in (
                    "running",
                    "cancel_requested",
                ):
                    if "'cancelled'" in sql:
                        db.state = "cancelled"
                    elif "'failed'" in sql:
                        db.state = "failed"
                    self.rowcount = 1

        return Cursor()

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rolled += 1


def _settle_with(fn, *args):
    token = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    job = {
        "id": "job-husk",
        "kind": "hillshade",
        "target_item_id": "item-husk",
        "claim_token": token,
    }
    runner.remember_lease("job-husk", token)
    runner._current_job_id = "job-husk"
    db = _JobDb()
    try:
        fn(db, job, *args)
    finally:
        runner._current_job_id = None
    return db


def test_failed_job_stamps_its_husk_item():
    db = _settle_with(runner.settle_failed, "bad input")
    assert db.state == "failed"
    assert db.item_patches == [
        {"processingState": "failed", "processingError": "bad input"}
    ]


def test_cancelled_job_stamps_its_husk_item():
    db = _settle_with(runner.settle_cancelled)
    assert db.state == "cancelled"
    assert len(db.item_patches) == 1
    assert db.item_patches[0]["processingState"] == "failed"
    assert "cancelled" in db.item_patches[0]["processingError"]


def test_source_keys_are_pinned_to_the_layer_prefix():
    tl = runner.TILE_LAYER_KEY_PREFIX
    assert (
        runner.pinned_source_key({"cogStorageKey": tl + "a/cog.tif"}, tl, "cogStorageKey")
        == tl + "a/cog.tif"
    )
    # Falls through to the next field when the first is empty.
    assert (
        runner.pinned_source_key(
            {"cogStorageKey": "", "storageKey": tl + "b.tif"},
            tl,
            "cogStorageKey",
            "storageKey",
        )
        == tl + "b.tif"
    )
    assert runner.pinned_source_key({}, tl, "cogStorageKey") is None
    for bad in (
        "feedback-screenshot/x.png",
        "item-point-cloud/y.copc.laz",
        tl + "../feedback-screenshot/x.png",
        tl,
    ):
        raised = False
        try:
            runner.pinned_source_key({"cogStorageKey": bad}, tl, "cogStorageKey")
        except RuntimeError:
            raised = True
        assert raised, bad


if __name__ == "__main__":
    test_is_cancel_requested()
    test_add_feet_field()
    test_stream_contours_with_feet()
    test_stream_contours_empty_input()
    test_reclaim_abandoned_scratch()
    test_plan_grid_chunks_single_when_under_budget()
    test_plan_grid_chunks_tiles_exactly()
    test_plan_grid_chunks_elkins_shape()
    test_pdal_bounds_str()
    test_compute_zonal_stats_arrays()
    test_finish_job_keeps_the_lease()
    test_merge_item_data_checks_the_lease_in_the_write()
    test_failed_job_stamps_its_husk_item()
    test_cancelled_job_stamps_its_husk_item()
    test_source_keys_are_pinned_to_the_layer_prefix()
    print("test_runner_units: all assertions passed")
