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


def do_contours(conn, s3, job):
    """Contour lines from an elevation COG: the GDAL half.

    gdal_contour draws the lines in the DEM's CRS; ogr2ogr
    reprojects to WGS84 (proper GeoJSON); a post-pass adds a feet
    field so popups read naturally for imperial users. The GeoJSON
    then goes to MinIO and the job flips to the 'ingest' state,
    where the API-side analysis bridge stages it into the EXISTING
    async import pipeline (engine writes stay in TypeScript). This
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
        s3.download_file(BUCKET, storage_key, str(src))
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
        )
        set_progress(conn, job["id"], 55)

        # Reproject to WGS84 so the GeoJSON is spec-shaped; the
        # import pipeline would also handle it, but being explicit
        # here means the artifact is valid on its own.
        wgs = work / "contours.geojson"
        run(
            [
                "ogr2ogr",
                "-f",
                "GeoJSON",
                "-t_srs",
                "EPSG:4326",
                str(wgs),
                str(raw),
            ],
            work,
        )
        set_progress(conn, job["id"], 65)

        # Feet field post-pass + feature count in one read.
        doc = json.loads(wgs.read_text())
        feats = doc.get("features", [])
        if not feats:
            raise RuntimeError(
                "No contour lines came out. The elevation layer may "
                "be flat at this line spacing; try a smaller height "
                "between lines."
            )
        for f in feats:
            props = f.setdefault("properties", {})
            ele = props.get("elevation_m")
            if isinstance(ele, (int, float)):
                props["elevation_ft"] = round(ele * 3.28084, 1)
        wgs.write_text(json.dumps(doc))
        set_progress(conn, job["id"], 72)

        key = f"analysis-artifact/{uuid.uuid4()}.geojson"
        size = wgs.stat().st_size
        log(f"  uploading {size} bytes ({len(feats)} lines) to {key}")
        s3.upload_file(
            str(wgs),
            BUCKET,
            key,
            ExtraArgs={"ContentType": "application/geo+json"},
        )

        # Hand off to the API-side bridge: merge the artifact key
        # into params and flip the state. The bridge stages the
        # file, enqueues the import job, and closes this job out.
        new_params = dict(params)
        new_params["artifactKey"] = key
        new_params["featureCount"] = len(feats)
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE analysis_job
                SET state = 'ingest', params = %s, progress = 80
                WHERE id = %s
                """,
                (json.dumps(new_params), job["id"]),
            )
        conn.commit()
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
        s3.download_file(BUCKET, storage_key, str(src))
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
        s3.download_file(BUCKET, storage_key, str(src))
        set_progress(conn, job["id"], 10)

        def grid(out: Path, ground_only: bool, output_type: str) -> None:
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
            run(["pdal", "pipeline", str(pipeline)], work)

        dsm = work / "dsm.tif"
        grid(dsm, ground_only=False, output_type="max")
        set_progress(conn, job["id"], 40)
        dtm = work / "dtm.tif"
        grid(dtm, ground_only=True, output_type="idw")
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


HANDLERS = {
    "hillshade": do_hillshade,
    "elevation": do_elevation,
    "viewshed": do_viewshed,
    "contours": do_contours,
    "steepness": do_steepness,
    "heightmap": do_heightmap,
    "sam-embed": do_sam_embed,
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
                outcome = handler(conn, s3, job)
                if outcome == "handoff":
                    # The handler moved the job into a state another
                    # worker owns (e.g. contours -> 'ingest' for the
                    # API-side bridge). Do not mark it done.
                    log(f"job {job['id']}: handed off")
                else:
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
