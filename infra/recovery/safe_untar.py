# SPDX-License-Identifier: AGPL-3.0-or-later
"""Extract a recovery tar that may only contain regular files.

Rejects absolute paths, parent segments, links, devices, and archives
whose uncompressed size exceeds GRATIS_RECOVERY_MAX_UNCOMPRESSED
(default 8 GiB). Members are written under the destination after the
destination path is resolved.
"""

import os
import sys
import tarfile
from pathlib import Path


def reject(message: str) -> None:
    raise SystemExit(message)


def safe_members(tar: tarfile.TarFile, max_bytes: int, max_members: int):
    members = tar.getmembers()
    if len(members) > max_members:
        reject('too many archive members')
    total = 0
    for member in members:
        name = member.name
        parts = name.split('/')
        if name.startswith('/') or name.startswith('\\') or any(part == '..' for part in parts):
            reject('unsafe archive member')
        if member.issym() or member.islnk() or member.isdev() or member.isfifo():
            reject('archive member is not a regular file')
        if member.isdir():
            continue
        if not member.isfile():
            reject('archive member is not a regular file')
        total += member.size
        if total > max_bytes:
            reject('archive exceeds the size limit')
        yield member


def extract(tar_path: Path, dest: Path, max_bytes: int, max_members: int) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with tarfile.open(tar_path, 'r:') as tar:
        for member in safe_members(tar, max_bytes, max_members):
            target = (dest / member.name).resolve()
            if target != root and not str(target).startswith(str(root) + os.sep):
                reject('archive member escapes the destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tar.extractfile(member)
            if src is None:
                reject('archive member is not a regular file')
            with target.open('wb') as out:
                remaining = member.size
                while remaining:
                    chunk = src.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
            os.chmod(target, 0o600)


def main() -> None:
    tar_path, dest = sys.argv[1:]
    max_bytes = int(os.environ.get('GRATIS_RECOVERY_MAX_UNCOMPRESSED', str(8 << 30)))
    max_members = int(os.environ.get('GRATIS_RECOVERY_MAX_MEMBERS', '32'))
    extract(Path(tar_path), Path(dest), max_bytes, max_members)


if __name__ == '__main__':
    main()
