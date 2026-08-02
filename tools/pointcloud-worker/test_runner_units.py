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
            (scratch / "unrelated").mkdir()
            removed = runner.reclaim_abandoned_scratch(Conn())
            left = sorted(p.name for p in scratch.iterdir())
            assert removed == 2, removed
            assert left == ["job-alive", "unrelated"], left
        finally:
            runner.SCRATCH = old


if __name__ == "__main__":
    test_is_cancel_requested()
    test_add_feet_field()
    test_stream_contours_with_feet()
    test_stream_contours_empty_input()
    test_reclaim_abandoned_scratch()
    print("test_runner_units: all assertions passed")
