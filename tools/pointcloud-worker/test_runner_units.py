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
    print("test_runner_units: all assertions passed")
