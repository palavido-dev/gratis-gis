# SPDX-License-Identifier: AGPL-3.0-or-later
"""GratisGIS point-cloud analysis worker (#184 / workbench foundation).

Polls the analysis_job table and executes server-heavy primitives.
v1 ships one job kind:

  hillshade: COPC point cloud -> DEM (PDAL writers.gdal, streaming)
             -> hillshade (gdaldem) -> COG (gdal_translate) ->
             MinIO -> stamped onto the pre-created tile_layer item
             in the cog-ready state, where the EXISTING pyramid
             worker picks it up and bakes PMTiles. The analysis
             pipeline deliberately ends inside the proven
             cog->pmtiles path instead of inventing a new serving
             route.

Claiming uses FOR UPDATE SKIP LOCKED so running several workers is
safe. Every job gets its own scratch subdirectory, removed on all
exit paths. Failures mark the job failed with a human-readable
error; the portal UI surfaces it verbatim, so messages here are
written for the user, not for logs.

Job lifecycle (mirrored in the AnalysisJob docstring in
prisma/schema.prisma; keep the two in sync):

  queued            waiting for a worker. A user cancel flips it to
                    'cancelled' in the API; this worker never sees it
                    because claim_job only selects 'queued'.
  running           claimed here. The worker beats heartbeat_at on
                    claim, on every progress write, and every ~10s
                    during long silent stretches (subprocess wait
                    loops, S3 transfers), so a live worker can never
                    look dead.
  ingest/importing  vector kinds (contours) hand off to the API-side
                    analysis bridge, which rides the import pipeline
                    and settles the row.
  cancel_requested  the user asked a running job to stop. Every beat
                    piggybacks a state read (single UPDATE ...
                    RETURNING); when it comes back cancel_requested
                    the beat raises JobCancelled, the active child
                    process is killed, scratch is cleaned by the
                    normal finally blocks, and the row is marked
                    'cancelled' (not failed).
  cancelled/failed/done  terminal. 'failed' is also written by the
                    reclaim sweep in the API-side bridge when
                    heartbeat_at goes stale for over 10 minutes,
                    because a SIGKILLed worker cannot flip its own
                    rows ('worker stopped responding').
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path

import boto3
import psycopg2
import psycopg2.extras

POLL_SECONDS = 10
SCRATCH = Path(os.environ.get("SCRATCH_DIR", "/scratch"))

# Guard rails for the demo-class box (4 cores / 8 GB). The API
# validates these too; the worker re-checks because jobs could be
# inserted by future paths that forget.
MAX_RASTER_CELLS = 12000 * 12000

# Disk safety for the point cloud merge (#203). A merge downloads
# every source tile into scratch AND untwine builds a large out-of-
# core temp on top of that, empirically well over the compressed
# input size (LAZ decompresses ~10x). Without a guard, a merge that
# is too big for the scratch disk fills it and, when scratch shares
# a volume with MinIO, endangers live object storage. So:
#   - before downloading, require free scratch of at least
#     SCRATCH_SAFETY_FACTOR x the total source size, or fail fast with
#     a plain-language message.
#   - never let free space fall below SCRATCH_MIN_RESERVE_BYTES mid-
#     run: checked in the download loop and by a watchdog around
#     untwine, which kills the merge rather than fill the disk.
# Both are env-tunable so an operator with a big dedicated scratch
# disk can loosen them.
SCRATCH_SAFETY_FACTOR = float(os.environ.get("MERGE_SCRATCH_FACTOR", "5"))
SCRATCH_MIN_RESERVE_BYTES = int(
    os.environ.get("MERGE_MIN_FREE_GB", "10")
) * 1024**3
# Wall-clock ceiling for a single merge's untwine pass. The small
# analysis jobs use a 1h subprocess timeout; a large point cloud
# merge legitimately runs much longer (303 tiles / 16GB was still
# building past an hour), so copc-build gets its own generous,
# tunable budget. #205 will estimate the real time up front and
# reject a merge that would blow this, instead of dying at the wall.
MERGE_TIMEOUT_SEC = int(os.environ.get("MERGE_TIMEOUT_SEC", "14400"))
# Point-cloud gridding (PDAL writers.gdal) for hillshade / elevation /
# height maps reads every point in a single pass; on a large cloud it
# legitimately runs past the small analysis jobs' 1h subprocess
# timeout (the 1.88B-point Elkins DTM grid was still going at 1h and
# got killed). Give the gridding its own generous, tunable ceiling,
# same shape as the merge budget. #208 (chunked gridding) is the
# structural fix that bounds this; this just stops the wall from
# killing a working grid meanwhile.
ANALYSIS_TIMEOUT_SEC = int(os.environ.get("ANALYSIS_TIMEOUT_SEC", "14400"))
# Imagery mosaic (#199): same shape as the merge budget. The GDAL
# half (per-source warp + COG translate) runs long on county-scale
# imagery; the API's MOSAIC_* cost model estimates against this wall
# and refuses up front what cannot finish inside it.
MOSAIC_TIMEOUT_SEC = int(os.environ.get("MOSAIC_TIMEOUT_SEC", "14400"))
# Scratch need relative to summed source bytes: sources + warped
# copies + the COG output + VRT overhead. Imagery has no untwine
# out-of-core blowup, so the factor sits below the lidar one.
MOSAIC_SCRATCH_FACTOR = float(os.environ.get("MOSAIC_SCRATCH_FACTOR", "4"))
GIB = 1024**3


class JobCancelled(Exception):
    """The user asked this job to stop. Raised out of a heartbeat,
    handled by the main loop as a clean 'cancelled' exit, never as
    a failure."""


def is_cancel_requested(state: object) -> bool:
    """Pure predicate for the piggybacked state read on each beat.
    Kept as its own function so the cancel semantics are unit
    testable without a database."""
    return state == "cancel_requested"


def log(msg: str) -> None:
    print(msg, flush=True)


def db_connect():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("MINIO_ENDPOINT", "http://minio:9000"),
        aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    )


BUCKET = os.environ.get("MINIO_BUCKET", "gratisgis")


def kill_proc(proc) -> None:
    """Kill a child and reap it. Children here are direct processes
    (Popen without a new session or process group; PDAL, GDAL and
    untwine do work in threads, not grandchild processes), so
    proc.kill() reaches everything. The wait prevents zombies when
    we unwind on cancel or timeout."""
    try:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=30)
    except Exception:
        pass


def run(
    cmd: list[str],
    cwd: Path,
    conn=None,
    job_id: str | None = None,
    timeout: int = 3600,
    capture_stdout: bool = False,
) -> str | None:
    """Run a tool to completion, raising with its output tail on
    failure. Formerly a blocking subprocess.run; now a Popen + wait
    loop so that, when conn/job_id are given, the job's heartbeat
    stays fresh while the tool runs. Even the "short" GDAL steps
    (gdalwarp to the web tiling scheme, COG translate) legitimately
    run for many silent minutes on county-sized rasters, and without
    beats the reclaim sweep would shoot a healthy job at the
    10-minute mark. The beat also carries the cancel check, so a
    user cancel kills the active tool within ~10s.

    Output goes to temp files, not pipes, same rationale as
    run_long: an undrained pipe deadlocks a chatty child. With
    capture_stdout=True the child's stdout is read back and
    returned (pdal info metadata, a few KB)."""
    log(f"  $ {' '.join(cmd)}")
    with tempfile.TemporaryFile(dir=str(cwd)) as out_f, \
            tempfile.TemporaryFile(dir=str(cwd)) as err_f:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=out_f, stderr=err_f)
        deadline = time.time() + timeout
        try:
            while True:
                try:
                    proc.wait(timeout=POLL_SECONDS)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if conn is not None and job_id is not None:
                    try:
                        # Beat without touching progress; raises
                        # JobCancelled on a user cancel and the
                        # finally below kills the child.
                        set_progress(conn, job_id, None)
                    except JobCancelled:
                        raise
                    except Exception:
                        pass  # liveness is best effort; a DB blip must not kill the tool
                if time.time() > deadline:
                    kill_proc(proc)
                    raise RuntimeError(
                        f"{cmd[0]} ran longer than {timeout // 60} minutes "
                        "and was stopped."
                    )
        finally:
            kill_proc(proc)
        if proc.returncode != 0:
            tail = output_tail(err_f) or output_tail(out_f)
            raise RuntimeError(f"{cmd[0]} failed: {tail}")
        if capture_stdout:
            out_f.seek(0)
            return out_f.read().decode("utf-8", errors="replace")
        return None


def free_bytes(path: Path) -> int:
    """Free bytes on the filesystem holding `path`."""
    return shutil.disk_usage(str(path)).free


def output_tail(handle, limit: int = 800) -> str:
    # Last `limit` characters of a child-output temp file, decoded
    # leniently. Reads a few bytes more than `limit` so a multi-byte
    # character split at the seek point cannot eat into the tail.
    try:
        size = handle.seek(0, os.SEEK_END)
        handle.seek(max(0, size - 4 * limit))
        return handle.read().decode("utf-8", errors="replace")[-limit:].strip()
    except Exception:
        return ""


def run_long(
    cmd: list[str],
    cwd: Path,
    conn,
    job_id: str,
    timeout: int,
    prog_from: int,
    prog_to: int,
    tau: float = 1200.0,
) -> None:
    """Run a long, single-shot tool (a PDAL gridding pass) that emits
    no progress of its own. Popen + poll so we can (a) honor a
    generous timeout instead of the 1h subprocess default that was
    silently killing large grids, and (b) creep the job progress from
    prog_from toward prog_to on a time curve so the UI shows movement
    instead of a frozen percentage. The curve is asymptotic
    (1 - e^-t/tau), so it never claims to finish early; the caller
    sets the real prog_to once the process actually returns. Same
    failure contract as run()."""
    log(
        f"  $ {' '.join(cmd)}  "
        f"(long-running, <{timeout // 3600}h, progress {prog_from}->{prog_to})"
    )
    # Child stdout/stderr go to temp files, not pipes. A pipe that
    # nobody drains while the child runs fills its 64KB kernel buffer
    # and blocks the child forever; chatty tools hit that wall, hung,
    # and then died at the deadline with a misleading timeout error.
    # Files have no backpressure, and the error tail is read after
    # exit. They live in the job's work dir so they sit on the
    # watched scratch disk and any leftovers ride the existing
    # rmtree cleanup.
    with tempfile.TemporaryFile(dir=str(cwd)) as out_f, \
            tempfile.TemporaryFile(dir=str(cwd)) as err_f:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=out_f, stderr=err_f)
        t0 = time.time()
        deadline = t0 + timeout
        last = -1
        try:
            while True:
                try:
                    proc.wait(timeout=POLL_SECONDS)
                    break
                except subprocess.TimeoutExpired:
                    pass
                elapsed = time.time() - t0
                frac = 1.0 - math.exp(-elapsed / tau)
                pct = min(
                    prog_from + int((prog_to - prog_from) * frac), prog_to - 1
                )
                try:
                    # Beat EVERY pass, not only when the percentage
                    # moved: near the curve's asymptote pct can sit
                    # still for many minutes, and heartbeat_at is
                    # what keeps the reclaim sweep from shooting a
                    # long, healthy grid. pct=None writes just the
                    # beat. The beat also carries the cancel check.
                    set_progress(conn, job_id, pct if pct != last else None)
                except JobCancelled:
                    raise  # finally kills the child on the way out
                except Exception:
                    pass  # progress/liveness is best effort; never fail the job over it
                last = pct
                if time.time() > deadline:
                    kill_proc(proc)
                    raise RuntimeError(
                        f"The gridding step ran longer than {timeout // 3600} "
                        "hours and was stopped. Try a coarser resolution or a "
                        "smaller area."
                    )
        finally:
            kill_proc(proc)
        if proc.returncode != 0:
            err = output_tail(err_f) or output_tail(out_f)
            raise RuntimeError(f"{cmd[0]} failed: {err}")


def run_with_disk_watchdog(
    cmd: list[str],
    cwd: Path,
    watch: Path,
    reserve: int,
    timeout: int = 3600,
    conn=None,
    job_id: str | None = None,
) -> None:
    """Run a long tool while watching free space on `watch`. If free
    space falls below `reserve`, kill the process and raise rather
    than let it fill the disk (which, on a volume shared with MinIO,
    would take down live storage). With conn/job_id, the watch loop
    also beats the job heartbeat (an untwine pass runs for hours
    with no other DB writes) and honors a user cancel. Same failure
    contract as run()."""
    log(
        f"  $ {' '.join(cmd)}  "
        f"(watchdog: keep >{reserve // GIB}GB free, <{timeout // 3600}h)"
    )
    # Temp files instead of pipes, same rationale as run_long: an
    # undrained pipe deadlocks a chatty child (untwine logs per tile,
    # so hundreds of tiles overflow the 64KB pipe buffer) and the
    # watchdog then kills a healthy merge with a bogus timeout.
    with tempfile.TemporaryFile(dir=str(cwd)) as out_f, \
            tempfile.TemporaryFile(dir=str(cwd)) as err_f:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=out_f, stderr=err_f)
        deadline = time.time() + timeout
        last_beat = 0.0
        try:
            while True:
                try:
                    proc.wait(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if free_bytes(watch) < reserve:
                    kill_proc(proc)
                    raise RuntimeError(
                        "Stopped the merge to protect the disk: free working "
                        f"space dropped below {reserve // GIB}GB. This set of "
                        "tiles needs more scratch space than is available. "
                        "Use fewer tiles or a larger scratch disk."
                    )
                now = time.monotonic()
                if (
                    conn is not None
                    and job_id is not None
                    and now - last_beat >= POLL_SECONDS
                ):
                    last_beat = now
                    try:
                        set_progress(conn, job_id, None)
                    except JobCancelled:
                        raise  # finally kills untwine on the way out
                    except Exception:
                        pass  # liveness is best effort
                if time.time() > deadline:
                    kill_proc(proc)
                    raise RuntimeError(
                        f"The merge ran longer than {timeout // 3600} hours "
                        "and was stopped. This area is very large; try fewer "
                        "tiles."
                    )
        finally:
            kill_proc(proc)
        if proc.returncode != 0:
            err = output_tail(err_f) or output_tail(out_f)
            raise RuntimeError(f"{cmd[0]} failed: {err}")


def set_progress(conn, job_id: str, pct: int | None) -> None:
    """Progress write, liveness beat, and cancel check in ONE round
    trip. heartbeat_at is how the API-side reclaim sweep tells a
    slow-but-alive worker from a dead one, so every progress write
    doubles as a beat; pct=None beats without touching progress
    (long tool runs that have nothing new to report). RETURNING
    state piggybacks the cancel check on the same UPDATE, so
    honoring cancel costs no extra query: when the API flipped the
    row to cancel_requested, raise JobCancelled and let the call
    stack unwind (the subprocess wait loops kill their child on the
    way out)."""
    with conn.cursor() as cur:
        if pct is None:
            cur.execute(
                "UPDATE analysis_job SET heartbeat_at = now() "
                "WHERE id = %s RETURNING state",
                (job_id,),
            )
        else:
            cur.execute(
                "UPDATE analysis_job "
                "SET progress = %s, heartbeat_at = now() "
                "WHERE id = %s RETURNING state",
                (pct, job_id),
            )
        row = cur.fetchone()
    conn.commit()
    if row is not None and is_cancel_requested(row[0]):
        raise JobCancelled()


class TransferBeat:
    """boto3 progress callback that keeps heartbeat_at fresh during
    long S3 downloads/uploads. A 16GB COPC on a slow disk moves for
    well over the 10-minute reclaim window with no other DB writes,
    which would get a healthy job shot. Runs on s3transfer's worker
    threads, so it uses its OWN connection (psycopg2 connections are
    not thread safe) behind a lock (multipart transfers call back
    from several threads at once), throttled to the normal beat
    cadence.

    A user cancel seen here raises JobCancelled inside the transfer
    thread, which s3transfer surfaces by failing the transfer; the
    handler's normal unwind takes over. Callers should re-raise
    JobCancelled after a failed transfer when `cancelled` is set,
    since boto3 may wrap the original exception.
    """

    def __init__(self, job_id: str):
        self.job_id = job_id
        self.lock = threading.Lock()
        # The claim/last step just beat; wait a full interval.
        self.last = time.monotonic()
        self.conn = None
        self.cancelled = False

    def __call__(self, _bytes_amount: int) -> None:
        with self.lock:
            if self.cancelled:
                raise JobCancelled()
            now = time.monotonic()
            if now - self.last < POLL_SECONDS:
                return
            self.last = now
            try:
                if self.conn is None or self.conn.closed:
                    self.conn = db_connect()
                with self.conn.cursor() as cur:
                    cur.execute(
                        "UPDATE analysis_job SET heartbeat_at = now() "
                        "WHERE id = %s RETURNING state",
                        (self.job_id,),
                    )
                    row = cur.fetchone()
                self.conn.commit()
                if row is not None and is_cancel_requested(row[0]):
                    self.cancelled = True
                    raise JobCancelled()
            except JobCancelled:
                raise
            except Exception:
                # Liveness is best effort here; a beat that cannot
                # reach the DB must not kill a healthy transfer.
                try:
                    if self.conn is not None:
                        self.conn.close()
                except Exception:
                    pass
                self.conn = None

    def close(self) -> None:
        with self.lock:
            if self.conn is not None:
                try:
                    self.conn.close()
                except Exception:
                    pass
                self.conn = None


def transfer_file(
    s3, op: str, key: str, path: Path, job_id: str, beat=None, **kw
) -> None:
    """download_file / upload_file with a TransferBeat attached, and
    the cancel signal re-raised as JobCancelled even when boto3
    wraps the callback's exception. Pass a shared `beat` for
    many-file loops (the merge downloads hundreds of tiles) so they
    reuse one beat connection instead of opening one per file."""
    owned = beat is None
    if beat is None:
        beat = TransferBeat(job_id)
    try:
        if op == "download":
            s3.download_file(BUCKET, key, str(path), Callback=beat)
        else:
            s3.upload_file(str(path), BUCKET, key, Callback=beat, **kw)
    except JobCancelled:
        raise
    except Exception:
        if beat.cancelled:
            raise JobCancelled()
        raise
    finally:
        if owned:
            beat.close()


def reclaim_abandoned_scratch(conn) -> int:
    """Remove job scratch dirs whose job is no longer alive (#206).

    Every handler works under SCRATCH/job-<id> (or copc-<id> for the
    merge) and removes its own dir in a finally, but a SIGKILL, an
    OOM, or a redeploy mid-job skips finally, and the partial
    downloads sit on the scratch volume forever. On a 300-tile merge
    that is real gigabytes on the same volume the disk guards (#203)
    are trying to protect.

    Keyed on the database rather than on "we just started, nothing
    can be running": that shortcut is only true for a single worker,
    and two workers already run against this table elsewhere in the
    stack. A dir survives only when its job row is genuinely in
    flight ('running' / 'cancel_requested') AND its heartbeat is
    fresh, the same liveness test the API-side reclaim sweep applies
    to the row itself. Unparseable dir names are left alone; scratch
    is shared machinery and this function only claims to understand
    its own naming.
    """
    removed = 0
    prefixes = ("job-", "copc-", "mosaic-")
    try:
        entries = [
            p for p in SCRATCH.iterdir()
            if p.is_dir() and p.name.startswith(prefixes)
        ]
    except OSError as err:
        log(f"scratch reclaim: cannot list {SCRATCH}: {err}")
        return 0
    for path in entries:
        job_id = path.name.split("-", 1)[1]
        if not job_id:
            continue
        alive = False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM analysis_job
                    WHERE id = %s
                      AND state IN ('running', 'cancel_requested')
                      AND COALESCE(heartbeat_at, started_at, created_at)
                          > now() - interval '10 minutes'
                    """,
                    (job_id,),
                )
                alive = cur.fetchone() is not None
            conn.commit()
        except psycopg2.Error:
            conn.rollback()
            # Includes a non-UUID dir name failing the id cast: not
            # ours to judge, leave it.
            continue
        if alive:
            continue
        try:
            shutil.rmtree(path)
            removed += 1
            log(f"scratch reclaim: removed abandoned {path.name}")
        except OSError as err:
            log(f"scratch reclaim: could not remove {path.name}: {err}")
    return removed


def claim_job(conn):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT * FROM analysis_job
            WHERE state = 'queued'
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            """
        )
        job = cur.fetchone()
        if job is None:
            conn.commit()
            return None
        # heartbeat_at starts at claim time so the reclaim window
        # opens from the moment this worker owns the row, not from
        # its first progress write.
        cur.execute(
            """
            UPDATE analysis_job
            SET state = 'running', started_at = now(),
                heartbeat_at = now(), progress = 1
            WHERE id = %s
            """,
            (job["id"],),
        )
    conn.commit()
    return job


def mark_cancelled(conn, job_id: str) -> None:
    """Terminal stamp for a user cancel. Guarded on the states this
    worker legitimately owns so a concurrent reclaim sweep (which
    may already have settled the row) is never overwritten."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE analysis_job
            SET state = 'cancelled', finished_at = now()
            WHERE id = %s AND state IN ('running', 'cancel_requested')
            """,
            (job_id,),
        )
    conn.commit()


def finish_job(conn, job_id: str, error: str | None) -> None:
    with conn.cursor() as cur:
        if error is None:
            cur.execute(
                """
                UPDATE analysis_job
                SET state = 'done', progress = 100, finished_at = now()
                WHERE id = %s
                """,
                (job_id,),
            )
        else:
            cur.execute(
                """
                UPDATE analysis_job
                SET state = 'failed', error = %s, finished_at = now()
                WHERE id = %s
                """,
                (error[:2000], job_id),
            )
    conn.commit()


def item_data(conn, item_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT data_json FROM item WHERE id = %s AND deleted_at IS NULL',
            (item_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise RuntimeError("Source item no longer exists.")
    return row[0] or {}


def merge_item_data(conn, item_id: str, patch: dict) -> None:
    # Merge `patch` into item.data_json instead of replacing the
    # whole document. Jobs here run for hours, and the API keeps
    # writing to the same item meanwhile; a wholesale write of a dict
    # the worker computed (or snapshotted at job start) silently
    # erases those concurrent changes. The jsonb || merge only
    # touches the keys the worker owns, so everything else survives.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE item
            SET data_json = data_json || %s::jsonb, updated_at = now()
            WHERE id = %s
            """,
            (json.dumps(patch), item_id),
        )
    conn.commit()


# Job kinds whose pre-created target item is a raster tile_layer stub
# that only this worker ever fills in. On failure the stub must not
# stay a blank husk with no state; main() stamps it via
# stamp_target_failed. The other kinds are excluded on purpose:
# copc-build stamps its own item with a tailored message inside its
# handler, contours' data_layer target is settled by the API-side
# analysis bridge, and sam-embed has no target item at all.
RASTER_TARGET_KINDS = {
    "hillshade",
    "elevation",
    "viewshed",
    "steepness",
    "heightmap",
}


def stamp_target_failed(conn, job, error: str) -> None:
    """Mark a failed job's pre-created target item as failed.

    Mirrors the copc-build failure stamp: processingState 'failed'
    plus a plain-language processingError, merged into data_json so
    concurrent API writes survive. Best-effort: the job row already
    carries the authoritative error, so a failure here only costs
    the item-page hint, not the diagnosis.
    """
    if job.get("kind") not in RASTER_TARGET_KINDS:
        return
    target = job.get("target_item_id")
    if not target:
        return
    try:
        merge_item_data(
            conn,
            target,
            {
                "processingState": "failed",
                "processingError": (error or "The analysis failed.")[:400],
            },
        )
    except Exception:
        conn.rollback()


def wgs84_bbox(tif: Path) -> list[float] | None:
    """[w, s, e, n] of a raster, via GDAL's python bindings."""
    try:
        from osgeo import gdal, osr  # available in the conda env

        gdal.UseExceptions()
        ds = gdal.Open(str(tif))
        gt = ds.GetGeoTransform()
        w, h = ds.RasterXSize, ds.RasterYSize
        corners = [
            (gt[0] + gt[1] * x + gt[2] * y, gt[3] + gt[4] * x + gt[5] * y)
            for x, y in ((0, 0), (0, h), (w, 0), (w, h))
        ]
        src = osr.SpatialReference()
        src.ImportFromWkt(ds.GetProjection())
        dst = osr.SpatialReference()
        dst.ImportFromEPSG(4326)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        tx = osr.CoordinateTransformation(src, dst)
        pts = [tx.TransformPoint(x, y)[:2] for x, y in corners]
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        return [min(lons), min(lats), max(lons), max(lats)]
    except Exception:  # metadata only; never fail the job over it
        return None


def do_hillshade(conn, s3, job) -> None:
    params = job["params"] or {}
    mode = params.get("mode", "dtm")
    resolution = float(params.get("resolution", 1.0))
    azimuth = float(params.get("azimuth", 315))
    altitude = float(params.get("altitude", 45))
    if not (0.25 <= resolution <= 50):
        raise RuntimeError("Resolution must be between 0.25 and 50 meters.")

    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("storageKey")
    if not storage_key:
        raise RuntimeError("Source point cloud has no uploaded file.")
    bounds = source.get("bounds")
    if bounds:
        cells_x = (float(bounds[3]) - float(bounds[0])) / resolution
        cells_y = (float(bounds[4]) - float(bounds[1])) / resolution
        if cells_x * cells_y > MAX_RASTER_CELLS:
            raise RuntimeError(
                "That resolution would produce a raster larger than this "
                "server allows. Pick a coarser resolution."
            )

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "source.copc.laz"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 15)

        # PDAL pipeline: COPC -> (ground-only for DTM) -> IDW grid.
        # All stages are streamable, so memory stays bounded by the
        # raster, not the 200M+ points.
        dem = work / "dem.tif"
        stages: list[dict] = [
            {"type": "readers.copc", "filename": str(src)}
        ]
        if mode == "dtm":
            stages.append(
                {"type": "filters.range", "limits": "Classification[2:2]"}
            )
        stages.append(
            {
                "type": "writers.gdal",
                "filename": str(dem),
                "resolution": resolution,
                "output_type": "idw",
                "window_size": 3,
                "gdaldriver": "GTiff",
                "gdalopts": "COMPRESS=DEFLATE,TILED=YES,BIGTIFF=IF_SAFER",
            }
        )
        pipeline = work / "pipeline.json"
        pipeline.write_text(json.dumps({"pipeline": stages}))
        run_long(
            ["pdal", "pipeline", str(pipeline)], work,
            conn, job["id"], ANALYSIS_TIMEOUT_SEC, 15, 60,
        )
        set_progress(conn, job["id"], 60)

        hs = work / "hillshade.tif"
        run(
            [
                "gdaldem",
                "hillshade",
                str(dem),
                str(hs),
                "-az",
                str(azimuth),
                "-alt",
                str(altitude),
                "-compute_edges",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 75)

        cog = work / "hillshade.cog.tif"
        run(
            [
                "gdal_translate",
                str(hs),
                str(cog),
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 85)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        transfer_file(
            s3, "upload", key, cog, job["id"],
            ExtraArgs={"ContentType": "image/tiff"},
        )
        set_progress(conn, job["id"], 95)

        # Stamp the pre-created tile_layer item into the cog-ready
        # state; the pyramid worker takes it from here. Field shape
        # mirrors what the tile-layer conversion pipeline writes.
        bbox = wgs84_bbox(cog)
        # Web-mercator zoom whose pixel size best matches the DEM
        # resolution; the pyramid worker tiles up to this level.
        max_zoom = max(
            0, min(19, math.ceil(math.log2(156543.03 / resolution)))
        )
        source_title_res = f"{resolution:g}m"
        data = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "fileName": f"hillshade-{mode}-{source_title_res}.tif",
            "sizeBytes": size,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "originalFormat": "cog",
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            "processingState": "cog-ready",
            "tileType": "png",
            "maxZoom": max_zoom,
            "minZoom": 0,
            "tileUrl": f"cog:///api/portal/tile-layer/{job['target_item_id']}/file",
        }
        if bbox:
            data["bbox"] = bbox
            data["centerLng"] = (bbox[0] + bbox[2]) / 2
            data["centerLat"] = (bbox[1] + bbox[3]) / 2
            data["centerZoom"] = max(0, max_zoom - 3)
        # Patch, not replace: every key in `data` is worker-owned;
        # anything the API added to the item while the job ran
        # survives the merge (see merge_item_data).
        merge_item_data(conn, job["target_item_id"], data)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def do_elevation(conn, s3, job) -> None:
    """Bare-earth elevation surface for 3D terrain (#186).

    COPC -> ground-only IDW grid (same streamable chain as the
    hillshade DTM step) -> single-band COG on the GoogleMaps tiling
    scheme in EPSG:3857, which is exactly what the browser's COG
    protocol needs to drive MapLibre's raster-dem terrain directly.
    No tile pyramid bake: the COG's internal overviews ARE the
    pyramid, and PNG re-encoding would destroy the float elevation
    values, so the item is stamped 'ready' and the pyramid worker
    never claims it.
    """
    params = job["params"] or {}
    resolution = float(params.get("resolution", 1.0))
    if not (0.25 <= resolution <= 50):
        raise RuntimeError("Resolution must be between 0.25 and 50 meters.")

    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("storageKey")
    if not storage_key:
        raise RuntimeError("Source point cloud has no uploaded file.")
    bounds = source.get("bounds")
    if bounds:
        cells_x = (float(bounds[3]) - float(bounds[0])) / resolution
        cells_y = (float(bounds[4]) - float(bounds[1])) / resolution
        if cells_x * cells_y > MAX_RASTER_CELLS:
            raise RuntimeError(
                "That resolution would produce a raster larger than this "
                "server allows. Pick a coarser resolution."
            )

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "source.copc.laz"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 15)

        dem = work / "dem.tif"
        stages: list[dict] = [
            {"type": "readers.copc", "filename": str(src)},
            {"type": "filters.range", "limits": "Classification[2:2]"},
            {
                "type": "writers.gdal",
                "filename": str(dem),
                "resolution": resolution,
                "output_type": "idw",
                "window_size": 3,
                "gdaldriver": "GTiff",
                "gdalopts": "COMPRESS=DEFLATE,TILED=YES,BIGTIFF=IF_SAFER",
            },
        ]
        pipeline = work / "pipeline.json"
        pipeline.write_text(json.dumps({"pipeline": stages}))
        run_long(
            ["pdal", "pipeline", str(pipeline)], work,
            conn, job["id"], ANALYSIS_TIMEOUT_SEC, 15, 60,
        )
        set_progress(conn, job["id"], 60)

        # DEM COG recipe from the browser COG protocol's docs: the
        # GoogleMapsCompatible tiling scheme forces EPSG:3857 output
        # aligned to the web tile grid with 256px blocks, bilinear
        # for the base resample, NEAREST for overviews (interpolating
        # across the nodata edge would invent phantom elevations).
        cog = work / "elevation.cog.tif"
        run(
            [
                "gdalwarp",
                str(dem),
                str(cog),
                "-of",
                "COG",
                "-co",
                "BLOCKSIZE=256",
                "-co",
                "TILING_SCHEME=GoogleMapsCompatible",
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "RESAMPLING=BILINEAR",
                "-co",
                "OVERVIEW_RESAMPLING=NEAREST",
                "-co",
                "ADD_ALPHA=NO",
                "-dstnodata",
                "NaN",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 85)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        transfer_file(
            s3, "upload", key, cog, job["id"],
            ExtraArgs={"ContentType": "image/tiff"},
        )
        set_progress(conn, job["id"], 95)

        bbox = wgs84_bbox(cog)
        max_zoom = max(
            0, min(19, math.ceil(math.log2(156543.03 / resolution)))
        )
        data = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            # Marks this layer as a ground-elevation surface usable
            # as 3D terrain. Consumers append #dem to the tile URL.
            "dem": True,
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "fileName": f"elevation-{resolution:g}m.tif",
            "sizeBytes": size,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "originalFormat": "cog",
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            # 'ready' (not 'cog-ready') so the pyramid worker never
            # claims it; the COG serves as-is through /file.cog.
            "processingState": "ready",
            "maxZoom": max_zoom,
            "minZoom": 0,
            "tileUrl": f"cog:///api/portal/tile-layer/{job['target_item_id']}/file.cog",
        }
        if bbox:
            data["bbox"] = bbox
            data["centerLng"] = (bbox[0] + bbox[2]) / 2
            data["centerLat"] = (bbox[1] + bbox[3]) / 2
            data["centerZoom"] = max(0, max_zoom - 3)
        # Patch, not replace: every key in `data` is worker-owned;
        # anything the API added to the item while the job ran
        # survives the merge (see merge_item_data).
        merge_item_data(conn, job["target_item_id"], data)
        # #211: the source cloud now has a matching DEM; record it
        # so maps offer this terrain when the cloud (or anything
        # derived from it) joins a map. A newer elevation job just
        # re-stamps, freshest ground truth wins.
        merge_item_data(
            conn,
            job["source_item_id"],
            {"preferredElevationItemId": job["target_item_id"]},
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


def do_viewshed(conn, s3, job) -> None:
    """Visibility from a spot, on an elevation COG.

    Crop the DEM to the look-distance window (viewshed cost scales
    with cells, and the answer outside the window is 'not visible'
    by definition), run gdal_viewshed, then color the binary result
    into a transparent-or-green RGBA COG and hand it to the proven
    cog->pmtiles pyramid path, exactly like hillshade.
    """
    params = job["params"] or {}
    lng = float(params["lng"])
    lat = float(params["lat"])
    height_m = float(params.get("heightM", 2))
    max_dist = float(params.get("maxDistanceM", 1600))
    if not (0.5 <= height_m <= 100):
        raise RuntimeError("Height must be between 0.5 and 100 meters.")
    if not (100 <= max_dist <= 20000):
        raise RuntimeError(
            "Look distance must be between 100 and 20000 meters."
        )

    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("cogStorageKey") or source.get("storageKey")
    if not storage_key:
        raise RuntimeError("The elevation layer has no file.")

    # Observer in the DEM's CRS (web mercator; the elevation job
    # always produces GoogleMapsCompatible EPSG:3857).
    r_earth = 6378137.0
    ox = math.radians(lng) * r_earth
    oy = r_earth * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "elevation.tif"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 15)

        from osgeo import gdal

        gdal.UseExceptions()
        ds = gdal.Open(str(src))
        gt = ds.GetGeoTransform()
        res = abs(gt[1])
        raster_w, raster_h = ds.RasterXSize, ds.RasterYSize
        x_min = gt[0]
        y_max = gt[3]
        x_max = x_min + gt[1] * raster_w
        y_min = y_max + gt[5] * raster_h
        ds = None

        radius_px = max_dist / res
        if (2 * radius_px) ** 2 > MAX_RASTER_CELLS:
            raise RuntimeError(
                "That distance is too far for this server at this "
                "layer's detail. Try a shorter distance."
            )
        if not (x_min <= ox <= x_max and y_min <= oy <= y_max):
            raise RuntimeError(
                "Pick a spot inside the elevation layer's area."
            )

        # Window = observer +- distance, clipped to the raster. The
        # small margin keeps the observer's own cell interior.
        margin = max_dist * 0.02 + res * 2
        w_ulx = max(x_min, ox - max_dist - margin)
        w_uly = min(y_max, oy + max_dist + margin)
        w_lrx = min(x_max, ox + max_dist + margin)
        w_lry = max(y_min, oy - max_dist - margin)
        crop = work / "crop.tif"
        run(
            [
                "gdal_translate",
                str(src),
                str(crop),
                "-projwin",
                str(w_ulx),
                str(w_uly),
                str(w_lrx),
                str(w_lry),
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "TILED=YES",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 35)

        vis = work / "visibility.tif"
        run(
            [
                "gdal_viewshed",
                "-b",
                "1",
                "-ox",
                str(ox),
                "-oy",
                str(oy),
                "-oz",
                str(height_m),
                "-md",
                str(max_dist),
                str(crop),
                str(vis),
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 70)

        # Binary 0/255 -> RGBA: hidden ground fully transparent,
        # visible ground a readable green. The nv line keeps nodata
        # (outside the DEM's coverage) transparent too.
        colors = work / "colors.txt"
        colors.write_text("nv 0 0 0 0\n0 0 0 0 0\n255 46 160 67 200\n")
        rgba = work / "rgba.tif"
        run(
            [
                "gdaldem",
                "color-relief",
                str(vis),
                str(colors),
                str(rgba),
                "-alpha",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 80)

        cog = work / "visibility.cog.tif"
        run(
            [
                "gdal_translate",
                str(rgba),
                str(cog),
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 88)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        transfer_file(
            s3, "upload", key, cog, job["id"],
            ExtraArgs={"ContentType": "image/tiff"},
        )
        set_progress(conn, job["id"], 95)

        bbox = wgs84_bbox(cog)
        max_zoom = max(0, min(19, math.ceil(math.log2(156543.03 / res))))
        data = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "fileName": "visibility.tif",
            "sizeBytes": size,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "originalFormat": "cog",
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            "processingState": "cog-ready",
            "tileType": "png",
            "maxZoom": max_zoom,
            "minZoom": 0,
            "tileUrl": f"cog:///api/portal/tile-layer/{job['target_item_id']}/file",
        }
        if bbox:
            data["bbox"] = bbox
            data["centerLng"] = (bbox[0] + bbox[2]) / 2
            data["centerLat"] = (bbox[1] + bbox[3]) / 2
            data["centerZoom"] = max(0, max_zoom - 3)
        # Patch, not replace: every key in `data` is worker-owned;
        # anything the API added to the item while the job ran
        # survives the merge (see merge_item_data).
        merge_item_data(conn, job["target_item_id"], data)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def add_feet_field(feature: dict) -> dict:
    """Add elevation_ft next to elevation_m on one feature's
    properties, in place. Tolerates missing/odd properties (a null
    elevation from a nodata edge) rather than failing a whole job
    over one line."""
    props = feature.setdefault("properties", {})
    ele = props.get("elevation_m")
    if isinstance(ele, (int, float)) and not isinstance(ele, bool):
        props["elevation_ft"] = round(ele * 3.28084, 1)
    return feature


def stream_contours_with_feet(seq_path: Path, out_path: Path) -> int:
    """GeoJSONSeq (one feature per line, as ogr2ogr -f GeoJSONSeq
    writes it) -> spec-shaped GeoJSON FeatureCollection with the
    feet field added, holding ONE feature in memory at a time.

    This replaces a json.loads of the whole artifact: a county's
    contour set is hundreds of MB of GeoJSON, and parsing it whole
    ballooned to several GB of python objects on an 8GB box that is
    usually also running a grid job. Line-delimited input makes the
    lean path trivial (each line is a complete Feature document),
    which is why the ogr2ogr step now emits GeoJSONSeq instead of a
    FeatureCollection. Returns the feature count, which the bridge
    passes to the import pipeline for its progress math.
    """
    count = 0
    with seq_path.open("r", encoding="utf-8") as src, \
            out_path.open("w", encoding="utf-8") as dst:
        dst.write('{"type":"FeatureCollection","features":[\n')
        for line in src:
            # GDAL writes RS-delimited sequences (RFC 8142) when
            # asked; tolerate the 0x1e prefix so a driver-default
            # change cannot silently corrupt the first parse.
            text = line.strip().lstrip("\x1e").strip()
            if not text:
                continue
            feature = add_feet_field(json.loads(text))
            if count:
                dst.write(",\n")
            dst.write(json.dumps(feature))
            count += 1
        dst.write("\n]}\n")
    return count


def do_contours(conn, s3, job):
    """Contour lines from an elevation COG: the GDAL half.

    gdal_contour draws the lines in the DEM's CRS; ogr2ogr
    reprojects to WGS84 and emits line-delimited GeoJSONSeq; a
    streaming post-pass adds a feet field (so popups read naturally
    for imperial users) while assembling the final spec-shaped
    FeatureCollection one feature at a time. The GeoJSON then goes
    to MinIO and the job flips to the 'ingest' state, where the
    API-side analysis bridge stages it into the EXISTING async
    import pipeline (engine writes stay in TypeScript). This
    handler therefore returns "handoff" so the main loop does not
    mark the job done.
    """
    params = job["params"] or {}
    interval = float(params.get("intervalM", 3.048))
    if not (0.5 <= interval <= 500):
        raise RuntimeError(
            "The height between lines must be between 0.5 and 500 meters."
        )

    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("cogStorageKey") or source.get("storageKey")
    if not storage_key:
        raise RuntimeError("The elevation layer has no file.")

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "elevation.tif"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 15)

        raw = work / "contours-raw.geojson"
        run(
            [
                "gdal_contour",
                "-b",
                "1",
                "-a",
                "elevation_m",
                "-i",
                str(interval),
                "-f",
                "GeoJSON",
                str(src),
                str(raw),
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 55)

        # Reproject to WGS84 AND switch to line-delimited GeoJSONSeq
        # in one pass: the feet post-pass below streams it line by
        # line instead of json.loads-ing the whole document (see
        # stream_contours_with_feet). The .geojsonl extension keeps
        # GDAL's default newline (not RS) record separator.
        seq = work / "contours-wgs84.geojsonl"
        run(
            [
                "ogr2ogr",
                "-f",
                "GeoJSONSeq",
                "-t_srs",
                "EPSG:4326",
                str(seq),
                str(raw),
            ],
            work,
            conn,
            job["id"],
        )
        # The native-CRS original is dead weight from here; drop it
        # so a big contour set does not hold three copies on scratch.
        raw.unlink(missing_ok=True)
        set_progress(conn, job["id"], 65)

        # Streaming feet-field pass; the artifact the bridge ingests
        # stays a plain spec-shaped FeatureCollection.
        wgs = work / "contours.geojson"
        count = stream_contours_with_feet(seq, wgs)
        if count == 0:
            raise RuntimeError(
                "No contour lines came out. The elevation layer may "
                "be flat at this line spacing; try a smaller height "
                "between lines."
            )
        seq.unlink(missing_ok=True)
        set_progress(conn, job["id"], 72)

        key = f"analysis-artifact/{uuid.uuid4()}.geojson"
        size = wgs.stat().st_size
        log(f"  uploading {size} bytes ({count} lines) to {key}")
        transfer_file(
            s3, "upload", key, wgs, job["id"],
            ExtraArgs={"ContentType": "application/geo+json"},
        )

        # Hand off to the API-side bridge: merge the artifact key
        # into params and flip the state. The bridge stages the
        # file, enqueues the import job, and closes this job out.
        new_params = dict(params)
        new_params["artifactKey"] = key
        new_params["featureCount"] = count
        # Conditional on 'running' so a cancel that lands between
        # our last beat and this handoff wins: without the guard the
        # flip would overwrite cancel_requested and the import would
        # run a job the user already stopped.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE analysis_job
                SET state = 'ingest', params = %s, progress = 80
                WHERE id = %s AND state = 'running'
                """,
                (json.dumps(new_params), job["id"]),
            )
            flipped = cur.rowcount
        conn.commit()
        if flipped == 0:
            # The artifact is orphaned now; drop it before unwinding
            # as a cancel (best effort, artifacts are small).
            try:
                s3.delete_object(Bucket=BUCKET, Key=key)
            except Exception:
                pass
            raise JobCancelled()
        return "handoff"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def do_steepness(conn, s3, job) -> None:
    """Steepness (slope) map from an elevation COG.

    gdaldem slope in degrees, colored through a fixed green-to-red
    ramp (flat to steep) into an RGBA COG that rides the normal
    cog->pmtiles pyramid path. Nodata stays transparent.
    """
    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("cogStorageKey") or source.get("storageKey")
    if not storage_key:
        raise RuntimeError("The elevation layer has no file.")

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "elevation.tif"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 15)

        from osgeo import gdal

        gdal.UseExceptions()
        ds = gdal.Open(str(src))
        res = abs(ds.GetGeoTransform()[1])
        ds = None

        slope = work / "slope.tif"
        run(
            [
                "gdaldem",
                "slope",
                str(src),
                str(slope),
                "-compute_edges",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 55)

        # Degrees -> color. Stops chosen for how people talk about
        # ground: walkable, gentle, noticeable, steep, very steep,
        # cliff-like. Values between stops interpolate.
        colors = work / "colors.txt"
        colors.write_text(
            "nv 0 0 0 0\n"
            "0 34 139 34 255\n"
            "5 154 205 50 255\n"
            "10 255 221 51 255\n"
            "20 255 140 0 255\n"
            "30 205 60 40 255\n"
            "45 139 26 26 255\n"
            "90 92 10 10 255\n"
        )
        rgba = work / "rgba.tif"
        run(
            [
                "gdaldem",
                "color-relief",
                str(slope),
                str(colors),
                str(rgba),
                "-alpha",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 75)

        cog = work / "steepness.cog.tif"
        run(
            [
                "gdal_translate",
                str(rgba),
                str(cog),
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 85)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        transfer_file(
            s3, "upload", key, cog, job["id"],
            ExtraArgs={"ContentType": "image/tiff"},
        )
        set_progress(conn, job["id"], 95)

        bbox = wgs84_bbox(cog)
        max_zoom = max(0, min(19, math.ceil(math.log2(156543.03 / res))))
        data = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "fileName": "steepness.tif",
            "sizeBytes": size,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "originalFormat": "cog",
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            "processingState": "cog-ready",
            "tileType": "png",
            "maxZoom": max_zoom,
            "minZoom": 0,
            "tileUrl": f"cog:///api/portal/tile-layer/{job['target_item_id']}/file",
        }
        if bbox:
            data["bbox"] = bbox
            data["centerLng"] = (bbox[0] + bbox[2]) / 2
            data["centerLat"] = (bbox[1] + bbox[3]) / 2
            data["centerZoom"] = max(0, max_zoom - 3)
        # Patch, not replace: every key in `data` is worker-owned;
        # anything the API added to the item while the job ran
        # survives the merge (see merge_item_data).
        merge_item_data(conn, job["target_item_id"], data)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def do_heightmap(conn, s3, job) -> None:
    """Height above ground: surface model minus ground model.

    Two streamed PDAL grids over ONE explicit bounds (the ground
    subset's extent can differ from the full cloud's, and implicit
    grids would misalign), differenced with gdal_calc while masking
    either side's nodata, clamped at zero (grid interpolation can
    dip the surface under the ground near edges), then colored
    through a green ramp: nothing standing = transparent, taller =
    deeper green.
    """
    params = job["params"] or {}
    resolution = float(params.get("resolution", 1.0))
    if not (0.25 <= resolution <= 50):
        raise RuntimeError("Resolution must be between 0.25 and 50 meters.")

    source = item_data(conn, job["source_item_id"])
    storage_key = source.get("storageKey")
    if not storage_key:
        raise RuntimeError("Source point cloud has no uploaded file.")
    bounds = source.get("bounds")
    if not bounds:
        raise RuntimeError(
            "This point cloud is missing its extent information."
        )
    cells_x = (float(bounds[3]) - float(bounds[0])) / resolution
    cells_y = (float(bounds[4]) - float(bounds[1])) / resolution
    if cells_x * cells_y > MAX_RASTER_CELLS:
        raise RuntimeError(
            "That resolution would produce a raster larger than this "
            "server allows. Pick a coarser resolution."
        )
    # PDAL writers.gdal bounds syntax: ([minx, maxx], [miny, maxy]).
    pdal_bounds = (
        f"([{float(bounds[0])}, {float(bounds[3])}], "
        f"[{float(bounds[1])}, {float(bounds[4])}])"
    )

    work = SCRATCH / f"job-{job['id']}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        src = work / "source.copc.laz"
        log(f"  downloading {storage_key}")
        transfer_file(s3, "download", storage_key, src, job["id"])
        set_progress(conn, job["id"], 10)

        def grid(
            out: Path,
            ground_only: bool,
            output_type: str,
            prog_from: int,
            prog_to: int,
        ) -> None:
            stages: list[dict] = [
                {"type": "readers.copc", "filename": str(src)}
            ]
            if ground_only:
                stages.append(
                    {
                        "type": "filters.range",
                        "limits": "Classification[2:2]",
                    }
                )
            stages.append(
                {
                    "type": "writers.gdal",
                    "filename": str(out),
                    "resolution": resolution,
                    "output_type": output_type,
                    "window_size": 3,
                    "bounds": pdal_bounds,
                    "nodata": -9999,
                    "gdaldriver": "GTiff",
                    "gdalopts": "COMPRESS=DEFLATE,TILED=YES,BIGTIFF=IF_SAFER",
                }
            )
            pipeline = work / f"pipeline-{out.stem}.json"
            pipeline.write_text(json.dumps({"pipeline": stages}))
            run_long(
                ["pdal", "pipeline", str(pipeline)], work,
                conn, job["id"], ANALYSIS_TIMEOUT_SEC, prog_from, prog_to,
            )

        dsm = work / "dsm.tif"
        grid(dsm, ground_only=False, output_type="max", prog_from=10, prog_to=40)
        set_progress(conn, job["id"], 40)
        dtm = work / "dtm.tif"
        grid(dtm, ground_only=True, output_type="idw", prog_from=40, prog_to=65)
        set_progress(conn, job["id"], 65)

        height = work / "height.tif"
        run(
            [
                "gdal_calc.py",
                "-A",
                str(dsm),
                "-B",
                str(dtm),
                "--calc",
                "where((A==-9999)|(B==-9999), -9999, maximum(A-B, 0))",
                "--NoDataValue=-9999",
                "--outfile",
                str(height),
                "--co",
                "COMPRESS=DEFLATE",
                "--co",
                "TILED=YES",
                "--quiet",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 75)

        # Meters of standing height -> color. Under half a meter is
        # grass and noise, so it fades to fully transparent and the
        # basemap shows through where nothing stands.
        colors = work / "colors.txt"
        colors.write_text(
            "nv 0 0 0 0\n"
            "0 0 0 0 0\n"
            "0.5 220 235 210 60\n"
            "2 178 216 160 140\n"
            "5 140 195 120 200\n"
            "10 90 165 90 230\n"
            "20 45 130 60 255\n"
            "30 20 100 45 255\n"
            "60 8 60 30 255\n"
        )
        rgba = work / "rgba.tif"
        run(
            [
                "gdaldem",
                "color-relief",
                str(height),
                str(colors),
                str(rgba),
                "-alpha",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 82)

        cog = work / "height.cog.tif"
        run(
            [
                "gdal_translate",
                str(rgba),
                str(cog),
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
            ],
            work,
            conn,
            job["id"],
        )
        set_progress(conn, job["id"], 88)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        transfer_file(
            s3, "upload", key, cog, job["id"],
            ExtraArgs={"ContentType": "image/tiff"},
        )
        set_progress(conn, job["id"], 95)

        bbox = wgs84_bbox(cog)
        max_zoom = max(
            0, min(19, math.ceil(math.log2(156543.03 / resolution)))
        )
        data = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "fileName": f"height-above-ground-{resolution:g}m.tif",
            "sizeBytes": size,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "originalFormat": "cog",
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            "processingState": "cog-ready",
            "tileType": "png",
            "maxZoom": max_zoom,
            "minZoom": 0,
            "tileUrl": f"cog:///api/portal/tile-layer/{job['target_item_id']}/file",
        }
        if bbox:
            data["bbox"] = bbox
            data["centerLng"] = (bbox[0] + bbox[2]) / 2
            data["centerLat"] = (bbox[1] + bbox[3]) / 2
            data["centerZoom"] = max(0, max_zoom - 3)
        # Patch, not replace: every key in `data` is worker-owned;
        # anything the API added to the item while the job ran
        # survives the merge (see merge_item_data).
        merge_item_data(conn, job["target_item_id"], data)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---- SAM click-to-outline: image embeddings ----------------------
#
# The magic-outline digitizing tool runs MobileSAM split in two:
# the heavy image ENCODER runs here (one job per 1024px map window,
# cached forever in MinIO), and the light mask DECODER runs in the
# browser per click. This handler is the encoder half.
#
# Window addressing: "supertiles" of 1024px on the standard web
# mercator grid, i.e. tile coords at zoom (z - 2). One embedding
# is 256x64x64 float32 = 4 MiB; the cache key is
# sam-embed/<itemId>/<z>/<gx>/<gy>.bin with a sibling .json.

SAM_ENCODER_PATH = os.environ.get(
    "SAM_ENCODER_PATH", "/models/mobilesam-encoder.onnx"
)
WEBMERC_HALF = 20037508.342789244
_SAM_SESSION = None


def sam_session():
    """Lazy-load the ONNX encoder once per worker process."""
    global _SAM_SESSION
    if _SAM_SESSION is None:
        import onnxruntime

        _SAM_SESSION = onnxruntime.InferenceSession(
            SAM_ENCODER_PATH, providers=["CPUExecutionProvider"]
        )
    return _SAM_SESSION


def supertile_bounds(z: int, gx: int, gy: int):
    """Web-mercator bounds of a 1024px supertile (= 4x4 z-tiles)."""
    n = 2 ** (z - 2)
    size = (2 * WEBMERC_HALF) / n
    x0 = -WEBMERC_HALF + gx * size
    y1 = WEBMERC_HALF - gy * size
    return x0, y1 - size, x0 + size, y1


def do_sam_embed(conn, s3, job) -> None:
    params = job["params"] or {}
    z = int(params["z"])
    gx = int(params["gx"])
    gy = int(params["gy"])
    if not (14 <= z <= 22):
        raise RuntimeError("Zoom in further to use the outline tool.")

    source = item_data(conn, job["source_item_id"])
    key = source.get("cogStorageKey")
    if not key:
        raise RuntimeError("This imagery layer has no image file.")

    import numpy as np
    from osgeo import gdal

    gdal.UseExceptions()
    # Windowed read straight from MinIO: GDAL's S3 filesystem with
    # the endpoint pointed at the internal MinIO service. Only the
    # blocks under the window are fetched, so embedding a view
    # costs a few MB, not the whole county image.
    endpoint = os.environ.get("MINIO_ENDPOINT", "http://minio:9000")
    gdal.SetConfigOption(
        "AWS_S3_ENDPOINT", endpoint.replace("http://", "").replace("https://", "")
    )
    gdal.SetConfigOption("AWS_HTTPS", "NO" if endpoint.startswith("http://") else "YES")
    gdal.SetConfigOption("AWS_VIRTUAL_HOSTING", "FALSE")
    gdal.SetConfigOption("AWS_ACCESS_KEY_ID", os.environ["MINIO_ACCESS_KEY"])
    gdal.SetConfigOption("AWS_SECRET_ACCESS_KEY", os.environ["MINIO_SECRET_KEY"])

    x0, y0, x1, y1 = supertile_bounds(z, gx, gy)
    src_path = f"/vsis3/{BUCKET}/{key}"
    set_progress(conn, job["id"], 10)
    ds = gdal.Open(src_path)
    try:
        window = gdal.Translate(
            "/vsimem/sam-window.tif",
            ds,
            projWin=[x0, y1, x1, y0],
            width=1024,
            height=1024,
            resampleAlg="bilinear",
        )
        arr = window.ReadAsArray()  # (bands, 1024, 1024)
        window = None
    finally:
        ds = None
        try:
            gdal.Unlink("/vsimem/sam-window.tif")
        except Exception:
            pass
    set_progress(conn, job["id"], 35)

    if arr is None:
        raise RuntimeError("Could not read the imagery under this view.")
    if arr.ndim == 2:  # single band -> fake RGB
        arr = np.stack([arr, arr, arr])
    rgb = arr[:3].astype(np.float32)  # (3, 1024, 1024)
    # SAM's ImageNet-style normalization, channel order RGB.
    mean = np.array([123.675, 116.28, 103.53], dtype=np.float32).reshape(3, 1, 1)
    std = np.array([58.395, 57.12, 57.375], dtype=np.float32).reshape(3, 1, 1)
    tensor = ((rgb - mean) / std)[np.newaxis, ...]  # (1, 3, 1024, 1024)

    sess = sam_session()
    input_name = sess.get_inputs()[0].name
    set_progress(conn, job["id"], 45)
    (embedding,) = sess.run(None, {input_name: tensor})
    set_progress(conn, job["id"], 85)
    emb = np.ascontiguousarray(embedding.astype(np.float32))

    base = f"sam-embed/{job['source_item_id']}/{z}/{gx}/{gy}"
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{base}.bin",
        Body=emb.tobytes(),
        ContentType="application/octet-stream",
    )
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{base}.json",
        Body=json.dumps(
            {
                "version": "mobilesam-v1",
                "shape": list(emb.shape),
                "mercBounds": [x0, y0, x1, y1],
                "z": z,
                "gx": gx,
                "gy": gy,
            }
        ).encode(),
        ContentType="application/json",
    )


def copc_header_meta(path: Path, conn=None, job_id: str | None = None) -> dict:
    """Lift point count, bounds, LAS version, point format, RGB flag,
    and CRS WKT from a COPC/LAS file via `pdal info --metadata`.
    Mirrors what the TypeScript finalize path reads from a single
    upload, so a merged cloud (#200) carries the same metadata a
    hand-uploaded one does. Runs through run() so a slow header read
    on a giant merged file (capped at 15 min, beyond the 10-min
    reclaim window) keeps beating the job heartbeat."""
    stdout = run(
        ["pdal", "info", "--metadata", str(path)],
        path.parent,
        conn,
        job_id,
        timeout=900,
        capture_stdout=True,
    )
    m = (json.loads(stdout or "{}") or {}).get("metadata", {}) or {}
    # Some PDAL builds nest the header under the reader stage name;
    # normalize to whichever dict actually carries the point count.
    if "count" not in m:
        for v in m.values():
            if isinstance(v, dict) and "count" in v:
                m = v
                break
    pdrf = int(m.get("dataformat_id", 0))
    srs = m.get("srs") if isinstance(m.get("srs"), dict) else {}
    wkt = (
        srs.get("compoundwkt")
        or srs.get("wkt")
        or m.get("comp_spatialreference")
        or m.get("spatialreference")
        or ""
    )
    return {
        "count": int(m.get("count", 0)),
        "bounds": [
            float(m["minx"]),
            float(m["miny"]),
            float(m["minz"]),
            float(m["maxx"]),
            float(m["maxy"]),
            float(m["maxz"]),
        ],
        "pointFormat": pdrf,
        "lasVersion": f"{m.get('major_version', 1)}.{m.get('minor_version', 4)}",
        # COPC allows point formats 6/7/8; 7 and 8 carry RGB. Include
        # the older RGB formats too so a pre-COPC source is read right.
        "hasRgb": pdrf in (2, 3, 5, 7, 8),
        "crsWkt": wkt,
    }


def bounds_to_wgs84(bounds: list[float], wkt: str) -> list[float] | None:
    """[w, s, e, n] from native bounds + WKT via osr. None on failure;
    the viewer just skips the pre-load bounding when it is absent."""
    if not wkt:
        return None
    try:
        from osgeo import osr

        src = osr.SpatialReference()
        src.ImportFromWkt(wkt)
        dst = osr.SpatialReference()
        dst.ImportFromEPSG(4326)
        src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        tx = osr.CoordinateTransformation(src, dst)
        corners = [
            (bounds[0], bounds[1]),
            (bounds[0], bounds[4]),
            (bounds[3], bounds[1]),
            (bounds[3], bounds[4]),
        ]
        pts = [tx.TransformPoint(x, y)[:2] for x, y in corners]
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        return [min(lons), min(lats), max(lons), max(lats)]
    except Exception:
        return None


def do_copc_build(conn, s3, job) -> None:
    """Merge several lidar tiles into one COPC (#200).

    Downloads the retained source tiles named in params.sourceKeys,
    runs untwine to build a single-file COPC over the whole set,
    lifts the merged header, uploads it, and stamps the point_cloud
    item 'ready'. Re-runnable by design: adding tiles later re-
    enqueues this over the full source set, and the item swaps to
    the freshly merged file with no gap in what the viewer serves
    (the old merged COPC is deleted only after the new one is live).
    """
    params = job["params"] or {}
    source_keys = params.get("sourceKeys") or []
    if not source_keys:
        raise RuntimeError("No source tiles to merge.")
    item_id = job["target_item_id"] or job["source_item_id"]
    # Existence check only, before we download gigabytes for a
    # deleted item. The data itself is deliberately NOT retained: a
    # merge runs for hours and the API keeps updating this item
    # meanwhile (newly uploaded source tiles land in sourceKeys), so
    # the final stamp below re-reads current state inside its own
    # transaction instead of trusting a job-start snapshot.
    item_data(conn, item_id)

    work = SCRATCH / f"copc-{job['id']}"
    srcdir = work / "src"
    srcdir.mkdir(parents=True, exist_ok=True)
    try:
        # Pre-flight disk check (#203). Sum the source sizes and refuse
        # up front if scratch can't hold the download plus untwine's
        # much larger out-of-core temp, rather than filling the disk.
        total_src = 0
        t_start = time.time()
        for key in source_keys:
            try:
                total_src += int(
                    s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
                )
            except Exception as err:
                raise RuntimeError(f"A source tile is missing: {key} ({err})")
        needed = int(total_src * SCRATCH_SAFETY_FACTOR)
        avail = free_bytes(SCRATCH)
        log(
            f"  {len(source_keys)} tiles, {total_src // GIB}GB; "
            f"need ~{needed // GIB}GB scratch, {avail // GIB}GB free"
        )
        if avail < needed:
            raise RuntimeError(
                f"This merge of {len(source_keys)} tiles needs about "
                f"{needed // GIB}GB of free working space but only "
                f"{avail // GIB}GB is available. Use fewer tiles, or give "
                "the worker a larger scratch disk."
            )

        t_dl0 = time.time()
        # One shared beat for the whole tile loop: it keeps the
        # heartbeat fresh (and the cancel check live) across a
        # multi-hour download without opening a connection per tile.
        dl_beat = TransferBeat(job["id"])
        try:
            for i, key in enumerate(source_keys):
                dest = srcdir / f"tile-{i:04d}.laz"
                log(
                    f"  downloading source {i + 1}/{len(source_keys)}: {key}"
                )
                transfer_file(
                    s3, "download", key, dest, job["id"], beat=dl_beat
                )
                # Bail if the download itself is eating into the reserve
                # (protects co-located MinIO from a runaway).
                if free_bytes(SCRATCH) < SCRATCH_MIN_RESERVE_BYTES:
                    raise RuntimeError(
                        "Stopped downloading tiles to protect the disk: free "
                        f"space fell below {SCRATCH_MIN_RESERVE_BYTES // GIB}GB. "
                        "Use fewer tiles or a larger scratch disk."
                    )
        finally:
            dl_beat.close()
        download_secs = int(time.time() - t_dl0)
        set_progress(conn, job["id"], 25)

        # untwine 1.5: single-file COPC is the default output. --files
        # takes the directory of tiles; --output_dir is (despite the
        # name) the output filename. Run under the disk watchdog so an
        # oversize out-of-core temp gets killed before it fills the
        # volume (which would take MinIO down with it).
        merged = work / "merged.copc.laz"
        t_untwine0 = time.time()
        run_with_disk_watchdog(
            ["untwine", "--files", str(srcdir), "--output_dir", str(merged)],
            work,
            SCRATCH,
            SCRATCH_MIN_RESERVE_BYTES,
            MERGE_TIMEOUT_SEC,
            conn=conn,
            job_id=job["id"],
        )
        untwine_secs = int(time.time() - t_untwine0)
        if not merged.exists():
            raise RuntimeError("The merge produced no output file.")
        set_progress(conn, job["id"], 75)

        meta = copc_header_meta(merged, conn, job["id"])
        set_progress(conn, job["id"], 82)

        key = f"item-point-cloud/{uuid.uuid4()}"
        size = merged.stat().st_size
        # Baseline timing (#205): one structured line per completed
        # merge so we can fit a "X GB / N tiles -> ~H hours" model and
        # reject oversized jobs up front instead of dying at the wall.
        total_secs = int(time.time() - t_start)
        log(
            "MERGE_STATS "
            f"tiles={len(source_keys)} in_bytes={total_src} "
            f"out_bytes={size} points={meta['count']} "
            f"download_secs={download_secs} untwine_secs={untwine_secs} "
            f"total_secs={total_secs}"
        )
        log(f"  uploading merged COPC ({size} bytes, {meta['count']} pts) to {key}")
        transfer_file(s3, "upload", key, merged, job["id"])
        set_progress(conn, job["id"], 92)

        # Final stamp: patch only the keys this worker owns. Writing
        # back a whole dict snapshotted at job start clobbered every
        # concurrent API write; for copc that meant source tiles the
        # user added mid-merge vanished from sourceKeys. The two
        # values that must be derived from CURRENT state (the
        # superseded merged file to delete, the fileName default) are
        # re-read inside this same transaction under the row lock, so
        # nothing can slide in between the read and the write.
        patch = {
            "version": 1,
            "format": "copc",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "sizeBytes": size,
            "uploadedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()
            ),
            "pointCount": meta["count"],
            "bounds": meta["bounds"],
            "lasVersion": meta["lasVersion"],
            "pointFormat": meta["pointFormat"],
            "hasRgb": meta["hasRgb"],
            "dataUrl": f"/api/portal/point-cloud/{item_id}/file.copc.laz",
            "processingState": "ready",
        }
        if meta["crsWkt"]:
            patch["crsWkt"] = meta["crsWkt"]
        bbox = bounds_to_wgs84(meta["bounds"], meta["crsWkt"])
        if bbox:
            patch["bboxWgs84"] = bbox

        with conn.cursor() as cur:
            cur.execute(
                "SELECT data_json FROM item WHERE id = %s FOR UPDATE",
                (item_id,),
            )
            row = cur.fetchone()
            current = (
                row[0] if row is not None and isinstance(row[0], dict) else {}
            )
            prev_key = current.get("storageKey")
            if not current.get("fileName"):
                patch["fileName"] = "merged.copc.laz"
            # `- 'processingError'` clears a stale failure note from
            # a previous run; || cannot remove keys, only set them.
            cur.execute(
                """
                UPDATE item
                SET data_json = (data_json - 'processingError') || %s::jsonb,
                    updated_at = now()
                WHERE id = %s
                """,
                (json.dumps(patch), item_id),
            )
        conn.commit()

        # The old merged COPC is now superseded. Never delete a source
        # tile (retained for re-merge) or the file we just wrote.
        if prev_key and prev_key != key and prev_key not in source_keys:
            try:
                s3.delete_object(Bucket=BUCKET, Key=prev_key)
            except Exception as err:
                log(f"  warn: could not delete old merged {prev_key}: {err}")
    except Exception as exc:
        # Stamp the item 'failed' so the UI stops spinning and shows a
        # reason; re-raise so the job row is marked failed too. The
        # retained sources let the user retry without re-uploading.
        # Surface our own plain-language reasons (disk space, a missing
        # tile) directly; fall back to the generic message for opaque
        # tool failures (an untwine/pdal stderr tail is not user copy).
        # Patch, not replace: writing back the job-start snapshot here
        # had the same clobber problem as the success path, erasing
        # source tiles added while the merge ran.
        msg = str(exc)
        low = msg.lower()
        user_facing = any(
            kw in low
            for kw in ("working space", "protect the disk", "a source tile is missing", "produced no output")
        )
        if isinstance(exc, JobCancelled):
            # Not an error: the user stopped the merge. Say so on
            # the item instead of the misleading "could not be
            # merged" text; the retained sources make a re-run a
            # one-click affair.
            user_facing = True
            msg = (
                "You cancelled this merge before it finished. The "
                "source tiles are kept, so you can run the merge "
                "again anytime."
            )
        # Roll back first: if `exc` was a database error, the open
        # transaction is aborted and the stamp below would be
        # rejected until it is cleared.
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            merge_item_data(
                conn,
                item_id,
                {
                    "processingState": "failed",
                    "processingError": (
                        msg[:400]
                        if user_facing
                        else (
                            "The tiles could not be merged. Check that they "
                            "are lidar files (.laz / .las / .copc.laz) in a "
                            "matching coordinate system."
                        )
                    ),
                },
            )
        except Exception:
            conn.rollback()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def raster_probe(path: Path) -> dict:
    """CRS + band structure of one source raster, via the bindings.

    Raises with a plain-language reason when the source is unusable:
    a mosaic silently missing one input is wrong output, not a
    degraded one, so unreadable sources fail the whole build.
    """
    from osgeo import gdal, osr

    gdal.UseExceptions()
    try:
        ds = gdal.Open(str(path))
    except Exception as err:
        raise RuntimeError(
            f"One of the images could not be read as a raster ({err})."
        )
    wkt = ds.GetProjection()
    if not wkt:
        raise RuntimeError(
            "One of the images has no map coordinates (no CRS). "
            "Export it as a georeferenced GeoTIFF and try again."
        )
    srs = osr.SpatialReference()
    srs.ImportFromWkt(wkt)
    web = osr.SpatialReference()
    web.ImportFromEPSG(3857)
    is_3857 = bool(srs.IsSame(web)) or srs.GetAuthorityCode(None) == "3857"
    has_alpha = False
    has_nodata = False
    for i in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(i)
        if band.GetColorInterpretation() == gdal.GCI_AlphaBand:
            has_alpha = True
        if band.GetNoDataValue() is not None:
            has_nodata = True
    return {
        "is3857": is_3857,
        "bands": ds.RasterCount,
        "hasAlpha": has_alpha,
        "hasNodata": has_nodata,
    }


def do_imagery_mosaic(conn, s3, job) -> None:
    """Compose several source rasters into one seamless COG (#199).

    Downloads the retained sources named in params.sourceKeys, warps
    each to web mercator where needed, builds a VRT over the set
    (later sources paint over earlier ones where images overlap, so
    the newest addition wins), bakes a single overview-carrying COG,
    and stamps the tile_layer item 'cog-ready'. From there the
    pyramid worker takes over exactly as if the mosaic had been
    uploaded as one file (photo COGs serve directly, everything else
    gets the PMTiles pyramid). Re-runnable by design: adding images
    later re-enqueues this over the full source set, and the item
    swaps to the fresh mosaic with no gap in what the viewer serves.
    """
    params = job["params"] or {}
    source_keys = params.get("sourceKeys") or []
    if not source_keys:
        raise RuntimeError("No source images to mosaic.")
    item_id = job["target_item_id"] or job["source_item_id"]
    # Existence check only; the final stamp re-reads current state
    # under its own row lock, same reasoning as copc-build.
    item_data(conn, item_id)

    work = SCRATCH / f"mosaic-{job['id']}"
    srcdir = work / "src"
    warpdir = work / "warp"
    srcdir.mkdir(parents=True, exist_ok=True)
    warpdir.mkdir(parents=True, exist_ok=True)
    try:
        # Pre-flight disk check (#203 rule): refuse up front rather
        # than fill the disk under a co-located MinIO.
        total_src = 0
        t_start = time.time()
        for key in source_keys:
            try:
                total_src += int(
                    s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
                )
            except Exception as err:
                raise RuntimeError(f"A source image is missing: {key} ({err})")
        needed = int(total_src * MOSAIC_SCRATCH_FACTOR)
        avail = free_bytes(SCRATCH)
        log(
            f"  {len(source_keys)} images, {total_src // GIB}GB; "
            f"need ~{needed // GIB}GB scratch, {avail // GIB}GB free"
        )
        if avail < needed:
            raise RuntimeError(
                f"This mosaic of {len(source_keys)} images needs about "
                f"{needed // GIB}GB of free working space but only "
                f"{avail // GIB}GB is available. Use fewer images, or give "
                "the worker a larger scratch disk."
            )

        t_dl0 = time.time()
        downloaded: list[Path] = []
        dl_beat = TransferBeat(job["id"])
        try:
            for i, key in enumerate(source_keys):
                dest = srcdir / f"src-{i:04d}"
                log(
                    f"  downloading source {i + 1}/{len(source_keys)}: {key}"
                )
                transfer_file(
                    s3, "download", key, dest, job["id"], beat=dl_beat
                )
                downloaded.append(dest)
                if free_bytes(SCRATCH) < SCRATCH_MIN_RESERVE_BYTES:
                    raise RuntimeError(
                        "Stopped downloading images to protect the disk: free "
                        f"space fell below {SCRATCH_MIN_RESERVE_BYTES // GIB}GB. "
                        "Use fewer images or a larger scratch disk."
                    )
        finally:
            dl_beat.close()
        download_secs = int(time.time() - t_dl0)
        set_progress(conn, job["id"], 20)

        # Normalize every source onto web mercator. Sources already
        # in 3857 join the VRT as-is; the rest are warped. The
        # photo test mirrors the pyramid worker's: exactly 3 bands,
        # no alpha, no nodata, across EVERY source. Photos bake to a
        # JPEG COG (the proven county-ortho serving shape); anything
        # else keeps DEFLATE so alpha / nodata / extra bands survive.
        t_gdal0 = time.time()
        vrt_inputs: list[Path] = []
        photo = True
        for i, src in enumerate(downloaded):
            probe = raster_probe(src)
            if probe["bands"] != 3 or probe["hasAlpha"] or probe["hasNodata"]:
                photo = False
            if probe["is3857"]:
                vrt_inputs.append(src)
                continue
            warped = warpdir / f"w-{i:04d}.tif"
            run_with_disk_watchdog(
                [
                    "gdalwarp",
                    "-t_srs", "EPSG:3857",
                    "-r", "bilinear",
                    "-of", "GTiff",
                    "-co", "TILED=YES",
                    "-co", "COMPRESS=DEFLATE",
                    "-co", "BIGTIFF=IF_SAFER",
                    str(src),
                    str(warped),
                ],
                work,
                SCRATCH,
                SCRATCH_MIN_RESERVE_BYTES,
                MOSAIC_TIMEOUT_SEC,
                conn=conn,
                job_id=job["id"],
            )
            vrt_inputs.append(warped)
        set_progress(conn, job["id"], 55)

        # VRT over the set. Input order is sourceKeys order and
        # gdalbuildvrt gives priority to files LATER in the list, so
        # where images overlap the newest addition wins; -resolution
        # highest keeps the finest source's detail in mixed-res sets.
        vrt = work / "mosaic.vrt"
        run(
            ["gdalbuildvrt", "-resolution", "highest", str(vrt)]
            + [str(p) for p in vrt_inputs],
            work,
            conn=conn,
            job_id=job["id"],
            timeout=MOSAIC_TIMEOUT_SEC,
        )
        set_progress(conn, job["id"], 60)

        cog = work / "mosaic.tif"
        compression = (
            ["-co", "COMPRESS=JPEG", "-co", "QUALITY=85"]
            if photo
            else ["-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2"]
        )
        run_with_disk_watchdog(
            [
                "gdal_translate",
                "-of", "COG",
                *compression,
                "-co", "BLOCKSIZE=512",
                "-co", "BIGTIFF=IF_SAFER",
                "-co", "RESAMPLING=BILINEAR",
                str(vrt),
                str(cog),
            ],
            work,
            SCRATCH,
            SCRATCH_MIN_RESERVE_BYTES,
            MOSAIC_TIMEOUT_SEC,
            conn=conn,
            job_id=job["id"],
        )
        gdal_secs = int(time.time() - t_gdal0)
        if not cog.exists():
            raise RuntimeError("The mosaic produced no output file.")
        set_progress(conn, job["id"], 85)

        # Output metadata, mirroring the single-file finalize path.
        bbox = wgs84_bbox(cog)
        max_zoom = None
        try:
            from osgeo import gdal as _gdal

            _gdal.UseExceptions()
            ds = _gdal.Open(str(cog))
            res = abs(ds.GetGeoTransform()[1])
            if res > 0:
                max_zoom = max(
                    0, min(22, math.ceil(math.log2(156543.03392804062 / res)))
                )
        except Exception:
            max_zoom = None  # metadata only; never fail the job over it

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        total_secs = int(time.time() - t_start)
        # Baseline timing (#205 rule): one structured line per build
        # so operators can re-fit the MOSAIC_* cost coefficients.
        log(
            "MOSAIC_STATS "
            f"tiles={len(source_keys)} in_bytes={total_src} "
            f"out_bytes={size} photo={int(photo)} "
            f"download_secs={download_secs} gdal_secs={gdal_secs} "
            f"total_secs={total_secs}"
        )
        log(f"  uploading mosaic COG ({size} bytes) to {key}")
        transfer_file(s3, "upload", key, cog, job["id"])
        set_progress(conn, job["id"], 92)

        patch = {
            "version": 1,
            "format": "cog",
            "kind": "raster",
            "originalFormat": "geotiff",
            "storageKey": key,
            "storageUrl": f"/api/portal/storage/private/{key}",
            "sizeBytes": size,
            "uploadedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()
            ),
            "cogStorageKey": key,
            "cogStorageUrl": f"/api/portal/storage/private/{key}",
            "cogSizeBytes": size,
            "processingState": "cog-ready",
            "tileType": "png",
            "tileUrl": f"cog:///api/portal/tile-layer/{item_id}/file",
        }
        if bbox:
            patch["bbox"] = bbox
            patch["centerLng"] = (bbox[0] + bbox[2]) / 2
            patch["centerLat"] = (bbox[1] + bbox[3]) / 2
        if max_zoom is not None:
            patch["maxZoom"] = max_zoom
            patch["minZoom"] = 0
            patch["centerZoom"] = max(0, max_zoom - 1)

        # Final stamp: patch only worker-owned keys, current state
        # re-read under the row lock (same clobber lesson as
        # copc-build). The pyramid fields are REMOVED, not patched:
        # a stale pmtilesStorageKey would keep serving the old
        # imagery from the bare endpoint until the new pyramid
        # lands, which is exactly the wrong bytes under a stamped
        # URL. Removing them puts the item in the plain cog-bridge
        # state the pyramid worker already knows how to pick up.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT data_json FROM item WHERE id = %s FOR UPDATE",
                (item_id,),
            )
            row = cur.fetchone()
            current = (
                row[0] if row is not None and isinstance(row[0], dict) else {}
            )
            stale_keys = [
                current.get("pmtilesStorageKey"),
                current.get("cogStorageKey"),
                current.get("storageKey"),
            ]
            if not current.get("fileName"):
                patch["fileName"] = f"mosaic-{len(source_keys)}-images.tif"
            cur.execute(
                """
                UPDATE item
                SET data_json = (data_json
                        - 'processingError' - 'pmtilesStorageKey'
                        - 'pmtilesStorageUrl' - 'pmtilesSizeBytes'
                        - 'tilingError' - 'tilingProgress'
                        - 'tilingStartedAt' - 'tilingCompletedAt'
                        - 'tilingAttempts') || %s::jsonb,
                    updated_at = now()
                WHERE id = %s
                """,
                (json.dumps(patch), item_id),
            )
        conn.commit()

        # Superseded files: the old baked mosaic / single-file COG
        # and its pyramid. Never delete a retained source or the
        # file just written.
        keep = set(source_keys) | {key}
        for stale in stale_keys:
            if stale and stale not in keep:
                try:
                    s3.delete_object(Bucket=BUCKET, Key=stale)
                except Exception as err:
                    log(f"  warn: could not delete superseded {stale}: {err}")
    except Exception as exc:
        msg = str(exc)
        low = msg.lower()
        user_facing = any(
            kw in low
            for kw in (
                "working space",
                "protect the disk",
                "a source image is missing",
                "produced no output",
                "could not be read as a raster",
                "no map coordinates",
            )
        )
        if isinstance(exc, JobCancelled):
            user_facing = True
            msg = (
                "You cancelled this mosaic before it finished. The "
                "source images are kept, so you can run the build "
                "again anytime."
            )
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            merge_item_data(
                conn,
                item_id,
                {
                    "processingState": "failed",
                    "processingError": (
                        msg[:400]
                        if user_facing
                        else (
                            "The images could not be combined. Check that "
                            "they are georeferenced rasters (GeoTIFF / JP2) "
                            "with valid coordinate systems."
                        )
                    ),
                },
            )
        except Exception:
            conn.rollback()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


HANDLERS = {
    "hillshade": do_hillshade,
    "elevation": do_elevation,
    "viewshed": do_viewshed,
    "contours": do_contours,
    "steepness": do_steepness,
    "heightmap": do_heightmap,
    "sam-embed": do_sam_embed,
    "copc-build": do_copc_build,
    "imagery-mosaic": do_imagery_mosaic,
}


def main() -> None:
    log(f"pointcloud-worker starting (poll every {POLL_SECONDS}s)")
    while True:
        try:
            conn = db_connect()
            break
        except Exception as err:
            log(f"db not ready: {err}; retrying")
            time.sleep(5)
    # A restart mid-job skipped every handler's finally; sweep the
    # leftovers before taking new work so a crash loop can never
    # ratchet the scratch volume toward full (#206).
    reclaimed = reclaim_abandoned_scratch(conn)
    if reclaimed:
        log(f"scratch reclaim: {reclaimed} abandoned dir(s) removed")
    s3 = s3_client()
    while True:
        try:
            job = claim_job(conn)
            if job is None:
                time.sleep(POLL_SECONDS)
                continue
            kind = job["kind"]
            log(f"job {job['id']}: {kind}")
            handler = HANDLERS.get(kind)
            if handler is None:
                finish_job(
                    conn,
                    job["id"],
                    f"This worker does not understand job kind '{kind}'.",
                )
                continue
            try:
                outcome = handler(conn, s3, job)
                if outcome == "handoff":
                    # The handler moved the job into a state another
                    # worker owns (e.g. contours -> 'ingest' for the
                    # API-side bridge). Do not mark it done.
                    log(f"job {job['id']}: handed off")
                else:
                    finish_job(conn, job["id"], None)
                    log(f"job {job['id']}: done")
            except JobCancelled:
                # Before the generic handler on purpose (it IS an
                # Exception): a user cancel is a clean stop, not a
                # failure. The heartbeat that noticed the cancel
                # already killed the active tool; the handler's
                # finally already removed its scratch dir. Mark the
                # row cancelled and leave the husk item a plain
                # explanation instead of an eternal spinner
                # (copc-build stamps its own tailored note in its
                # handler, same as its failure path).
                conn.rollback()
                log(f"job {job['id']}: cancelled by user")
                mark_cancelled(conn, job["id"])
                stamp_target_failed(
                    conn,
                    job,
                    "This analysis was cancelled before it finished.",
                )
            except Exception as err:
                conn.rollback()
                log(f"job {job['id']}: FAILED\n{traceback.format_exc()}")
                finish_job(conn, job["id"], str(err))
                # Raster jobs pre-create their target tile_layer item;
                # without this stamp a failure leaves that item as a
                # blank husk with no state and no explanation.
                stamp_target_failed(conn, job, str(err))
        except psycopg2.Error:
            log("db connection lost; reconnecting")
            time.sleep(5)
            try:
                conn.close()
            except Exception:
                pass
            while True:
                try:
                    conn = db_connect()
                    break
                except Exception as err:
                    log(f"db not ready: {err}; retrying")
                    time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
