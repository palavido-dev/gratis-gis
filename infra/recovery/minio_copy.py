# SPDX-License-Identifier: AGPL-3.0-or-later
"""Copy a MinIO bucket to a directory, or restore that directory.

Stdlib signing is avoided: boto3 is the S3 client already used by the
point-cloud worker. The script prints only counts, never keys' bytes
and never credentials.
"""

import json
import os
import sys
from pathlib import Path

import boto3
from botocore.client import Config


def client():
    return boto3.client(
        's3',
        endpoint_url=os.environ['MINIO_ENDPOINT'],
        aws_access_key_id=os.environ['MINIO_ACCESS_KEY'],
        aws_secret_access_key=os.environ['MINIO_SECRET_KEY'],
        config=Config(signature_version='s3v4'),
        region_name='us-east-1',
    )


def pull(bucket: str, dest: Path) -> None:
    s3 = client()
    dest.mkdir(parents=True, exist_ok=True)
    token = None
    count = 0
    total = 0
    while True:
        kwargs = {'Bucket': bucket}
        if token:
            kwargs['ContinuationToken'] = token
        page = s3.list_objects_v2(**kwargs)
        root = dest.resolve()
        for obj in page.get('Contents', []):
            key = obj['Key']
            target = (dest / key).resolve()
            if target != root and not str(target).startswith(str(root) + os.sep):
                raise SystemExit('object key escapes the destination')
            target.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(bucket, key, str(target))
            count += 1
            total += int(obj['Size'])
        if not page.get('IsTruncated'):
            break
        token = page.get('NextContinuationToken')
    print(json.dumps({'objectCount': count, 'totalBytes': total}))


def push(bucket: str, src: Path) -> None:
    s3 = client()
    # A fresh volume has no bucket. Creating it is part of restoring
    # the objects. A credential or network failure still raises.
    try:
        s3.head_bucket(Bucket=bucket)
    except Exception:
        s3.create_bucket(Bucket=bucket)
    existing = set()
    token = None
    while True:
        kwargs = {'Bucket': bucket}
        if token:
            kwargs['ContinuationToken'] = token
        try:
            page = s3.list_objects_v2(**kwargs)
        except Exception:
            page = {}
        for obj in page.get('Contents', []):
            existing.add(obj['Key'])
        if not page.get('IsTruncated'):
            break
        token = page.get('NextContinuationToken')
    restored = set()
    count = 0
    for path in sorted(p for p in src.rglob('*') if p.is_file()):
        key = path.relative_to(src).as_posix()
        s3.upload_file(str(path), bucket, key)
        restored.add(key)
        count += 1
    # Drop keys the bundle does not contain so a partial earlier
    # restore cannot leave objects the manifest did not list.
    for stale in sorted(existing - restored):
        s3.delete_object(Bucket=bucket, Key=stale)
    print(json.dumps({'objectCount': count}))


WRITE_DENY = {
    'Version': '2012-10-17',
    'Statement': [
        {
            'Effect': 'Deny',
            'Principal': '*',
            'Action': ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
            'Resource': [],
        }
    ],
}


def freeze(bucket: str) -> None:
    """Deny new object writes for the duration of a capture.

    A paused compose service does not cover a client that uploads
    straight to the bucket. The policy is removed by thaw. Root
    credentials on some MinIO builds bypass this; the capture still
    pauses writer services, and a drill checks both.
    """
    policy = json.loads(json.dumps(WRITE_DENY))
    policy['Statement'][0]['Resource'] = [
        f'arn:aws:s3:::{bucket}',
        f'arn:aws:s3:::{bucket}/*',
    ]
    client().put_bucket_policy(Bucket=bucket, Policy=json.dumps(policy))
    print(json.dumps({'writesFrozen': True}))


def thaw(bucket: str) -> None:
    s3 = client()
    try:
        s3.delete_bucket_policy(Bucket=bucket)
    except Exception as exc:
        text = str(exc)
        if 'NoSuchBucketPolicy' not in text and '404' not in text:
            raise
    print(json.dumps({'writesFrozen': False}))


def main() -> None:
    mode, bucket = sys.argv[1], sys.argv[2]
    if mode == 'pull':
        pull(bucket, Path(sys.argv[3]))
    elif mode == 'push':
        push(bucket, Path(sys.argv[3]))
    elif mode == 'freeze':
        freeze(bucket)
    elif mode == 'thaw':
        thaw(bucket)
    else:
        raise SystemExit('mode must be pull, push, freeze, or thaw')


if __name__ == '__main__':
    main()
