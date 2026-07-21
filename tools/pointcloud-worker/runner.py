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
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
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


def run(cmd: list[str], cwd: Path) -> None:
    """Run a tool, raising with its stderr tail on failure."""
    log(f"  $ {' '.join(cmd)}")
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=3600
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise RuntimeError(f"{cmd[0]} failed: {tail}")


def set_progress(conn, job_id: str, pct: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE analysis_job SET progress = %s WHERE id = %s",
            (pct, job_id),
        )
    conn.commit()


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
        cur.execute(
            """
            UPDATE analysis_job
            SET state = 'running', started_at = now(), progress = 1
            WHERE id = %s
            """,
            (job["id"],),
        )
    conn.commit()
    return job


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
        s3.download_file(BUCKET, storage_key, str(src))
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
        run(["pdal", "pipeline", str(pipeline)], work)
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
        )
        set_progress(conn, job["id"], 85)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        s3.upload_file(
            str(cog),
            BUCKET,
            key,
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
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE item
                SET data_json = %s, updated_at = now()
                WHERE id = %s
                """,
                (json.dumps(data), job["target_item_id"]),
            )
        conn.commit()
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
        s3.download_file(BUCKET, storage_key, str(src))
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
        run(["pdal", "pipeline", str(pipeline)], work)
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
        )
        set_progress(conn, job["id"], 85)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        s3.upload_file(
            str(cog),
            BUCKET,
            key,
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
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE item
                SET data_json = %s, updated_at = now()
                WHERE id = %s
                """,
                (json.dumps(data), job["target_item_id"]),
            )
        conn.commit()
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
        s3.download_file(BUCKET, storage_key, str(src))
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
        )
        set_progress(conn, job["id"], 88)

        key = f"item-tile-layer/{uuid.uuid4()}"
        size = cog.stat().st_size
        log(f"  uploading {size} bytes to {key}")
        s3.upload_file(
            str(cog),
            BUCKET,
            key,
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
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE item
                SET data_json = %s, updated_at = now()
                WHERE id = %s
                """,
                (json.dumps(data), job["target_item_id"]),
            )
        conn.commit()
    finally:
        shutil.rmtree(work, ignore_errors=True)


HANDLERS = {
    "hillshade": do_hillshade,
    "elevation": do_elevation,
    "viewshed": do_viewshed,
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
                handler(conn, s3, job)
                finish_job(conn, job["id"], None)
                log(f"job {job['id']}: done")
            except Exception as err:
                conn.rollback()
                log(f"job {job['id']}: FAILED\n{traceback.format_exc()}")
                finish_job(conn, job["id"], str(err))
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
