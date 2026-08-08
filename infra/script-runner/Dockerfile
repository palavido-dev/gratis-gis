# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Execution host for user-authored scripts (#221).
#
# Built FROM the portal-api image rather than from scratch: the runner
# is the same Nest codebase, and rebuilding the Node layer here would
# mean two places to keep the Prisma client and the compiled sources
# in step. This layer adds only what that image lacks, which is Python.
#
# Dependency policy: frozen. The set below is what a script gets, and
# a script that needs something else does not run until this file
# changes and the image is rebuilt. That is a real limitation and a
# deliberate one for the first release:
#
#   - No pip at run time means no reaching the public index from a
#     scheduled job on the operator's own machine, and no install step
#     that could fail at 3am for reasons nobody is awake to see.
#   - Every run starts from an identical, cached environment, so a
#     script that worked last month works this month.
#   - It surfaces demand honestly. The libraries people actually ask
#     for will show up in feedback, rather than being guessed at now.
#
# Grow this list when someone needs something. An allowlist an admin
# can extend without a deploy is the natural next step if the rebuild
# cadence becomes annoying.
ARG PORTAL_API_IMAGE=gratis-gis/portal-api:latest
FROM ${PORTAL_API_IMAGE}

USER root

# python3-venv rather than the system interpreter's site-packages:
# Debian marks its Python as externally managed, and installing into
# it with --break-system-packages is exactly the kind of shortcut that
# makes a later base-image bump fail mysteriously.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      python3-pip \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV SCRIPT_VENV=/opt/script-venv
RUN python3 -m venv "$SCRIPT_VENV"

# The portal's own client first, from the repo rather than the index:
# the runner and the client ship together, so a script on the server
# runs against the same version the repo declares.
COPY clients/python /tmp/gratisgis-client
RUN "$SCRIPT_VENV/bin/pip" install --no-cache-dir --upgrade pip \
 && "$SCRIPT_VENV/bin/pip" install --no-cache-dir /tmp/gratisgis-client \
 && rm -rf /tmp/gratisgis-client

# The curated set. Deliberately small: enough to fetch from a county
# endpoint, reshape a table, and do geometry, which is the shape of
# the maintenance jobs this feature exists for.
RUN "$SCRIPT_VENV/bin/pip" install --no-cache-dir \
      "httpx>=0.28,<0.29" \
      "requests>=2.32,<3" \
      "pandas>=2.2,<3" \
      "shapely>=2.0,<3" \
      "pyproj>=3.6,<4" \
      "python-dateutil>=2.9,<3"

# The runner spawns this interpreter, not the system one.
ENV SCRIPT_PYTHON=/opt/script-venv/bin/python3
# Scripts get a writable HOME they do not share with the app user's,
# so a library that caches into ~ cannot write anywhere interesting.
ENV SCRIPT_HOME=/tmp
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# A dedicated identity for user code, distinct from the one the
# executor process runs as.
#
# This exists because of something measured, not imagined. When the
# script ran as the SAME user as the executor, it could read
# /proc/1/environ and recover the executor's whole environment,
# including SCRIPT_EXECUTOR_TOKEN. The environment scrub prevents the
# child INHERITING variables; it does nothing about reading the
# parent's copy off /proc, because /proc/<pid>/environ is readable by
# the owning UID.
#
# Different UID closes that: the kernel refuses the read. It also means
# a script cannot signal, trace, or otherwise interfere with the
# process supervising it.
#
# 10001 is arbitrary and high, chosen to avoid colliding with anything
# the base image adds later.
# The scratch parent is root-owned 0711, NOT owned by the script user.
#
# Subtle and load-bearing. The executor drops CAP_DAC_OVERRIDE along
# with every other capability, which means its root cannot write into
# a directory owned by someone else; the first run after that hardening
# failed with EACCES on mkdtemp. Root-owned means root can create each
# run's directory, and mode 0711 lets the script user traverse into the
# one path it is handed without being able to list the parent and see
# other runs.
#
# Each run's own directory is then chowned to the script user, which is
# what CAP_CHOWN is for.
RUN groupadd -g 10001 ggscript \
 && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin ggscript \
 && mkdir -p /home/ggscript /var/tmp/ggscript \
 && chown ggscript:ggscript /home/ggscript \
 && chmod 0700 /home/ggscript \
 && chown root:root /var/tmp/ggscript \
 && chmod 0711 /var/tmp/ggscript
ENV SCRIPT_UID=10001
ENV SCRIPT_GID=10001
ENV SCRIPT_HOME=/home/ggscript
# Scratch space for a run, owned by the script user rather than
# shared /tmp, so one run cannot plant files another one reads.
ENV SCRIPT_TMPDIR=/var/tmp/ggscript

# NOTE: no `USER app` here.
#
# The executor process stays root so it can drop to SCRIPT_UID when it
# spawns the child; an unprivileged parent cannot change a child's
# user. That is the standard privilege-separation shape, and it is
# strictly better than the alternative it replaces, where the
# untrusted child had exactly the same privileges as its supervisor.
#
# The compose service pins this down: every Linux capability dropped
# except SETUID/SETGID, and no-new-privileges. Root with no
# capabilities, no secrets, and no database is a much smaller thing
# than the word "root" suggests.
CMD ["node", "dist/script-worker.main.js"]
