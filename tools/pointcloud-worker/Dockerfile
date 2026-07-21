# GratisGIS point-cloud analysis worker (#184 / workbench).
#
# Runs the server-heavy analysis tier: PDAL (COPC reading, DEM
# rasterization), untwine (out-of-core COPC building for the #182
# merge pipeline), and GDAL (hillshade, COG output), installed from
# conda-forge because none of them are sanely available as Debian
# packages at current versions. The image is deliberately separate
# from portal-api / portal-worker so the Node images stay lean and
# operators on small boxes can simply not run this service, which
# is what the capability-tier gating checks.
#
# Version pins follow the repo convention after the node:25
# floating-tag incident: bump deliberately.
FROM mambaorg/micromamba:2.3.2

USER root
# Pins chosen as the newest set that co-solves on conda-forge
# (untwine 1.5 requires pdal 2.10, which drags gdal 3.13 and
# python 3.14; older gdal/python pins make the solve impossible).
RUN micromamba install -y -n base -c conda-forge \
      python=3.14 \
      pdal=2.10 \
      untwine=1.5 \
      gdal=3.13 \
      psycopg2 \
      boto3 \
      numpy \
      onnxruntime \
    && micromamba clean --all --yes

# MobileSAM image encoder for the magic-outline tool (#sam). Pulled
# from our own pinned model release (exported from the official
# Apache-2.0 MobileSAM checkpoint; provenance + license in the
# release notes) and hash-verified so a tampered or truncated
# download fails the build, not the first job.
ADD https://github.com/palavido-dev/gratis-gis/releases/download/models-mobilesam-v1/mobilesam-encoder.onnx /models/mobilesam-encoder.onnx
RUN echo "d02f3fe0bd70731cd6efd004ca1fef1e14e6ac2e1c4804a2ca0926256d886cdf  /models/mobilesam-encoder.onnx" | sha256sum -c - \
    && chmod a+r /models/mobilesam-encoder.onnx

WORKDIR /app
COPY tools/pointcloud-worker/runner.py /app/runner.py

# Scratch for downloads + intermediate rasters. Mounted as a
# volume in compose so a mid-job crash doesn't bloat the container
# layer; the runner cleans per-job subdirectories on every path.
ENV SCRATCH_DIR=/scratch
RUN mkdir -p /scratch && chown mambauser /scratch /app
USER mambauser

# micromamba's entrypoint activates the base env so pdal/gdal are
# on PATH for the runner's subprocess calls.
ENTRYPOINT ["/usr/local/bin/_entrypoint.sh"]
CMD ["python", "/app/runner.py"]
