#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Prove the QR encoder produces codes a real decoder can read.

    pip install opencv-python-headless numpy
    python3 packages/shared-types/scripts/verify-qr-scannable.py

This is the check that actually matters for src/qr.ts, and the one the
unit tests cannot do. `qr.spec.ts` pins matrices against golden output
we generated ourselves, which catches drift but could never have
caught the encoder being wrong on day one: a symbol with a bad format
field, a mis-ordered generator polynomial or a broken zigzag still
renders a convincing square of dots.

OpenCV's decoder is an implementation with nothing in common with
ours, so a successful round trip is real evidence.

Reads the golden fixture rather than running the TypeScript, so keep
them in step: regenerate the fixture first if you changed the encoder.

Note on masks: OpenCV reliably fails to read mask 2 applied to highly
repetitive payloads ("aaaa..."), and fails on other encoders' output
for the same input, so a lone mask-2 failure on synthetic filler is a
decoder limitation and not a defect here. Real URLs decode on all
eight masks.
"""
import json
import pathlib
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("needs opencv-python-headless and numpy")

FIXTURE = (
    pathlib.Path(__file__).resolve().parents[1]
    / "src"
    / "__fixtures__"
    / "qr-golden.json"
)

MODULE_PX = 8
QUIET = 4


def render(rows):
    n = len(rows)
    dim = (n + QUIET * 2) * MODULE_PX
    img = np.ones((dim, dim), np.uint8) * 255
    for r in range(n):
        for c in range(n):
            if rows[r][c] == "1":
                y = (r + QUIET) * MODULE_PX
                x = (c + QUIET) * MODULE_PX
                img[y : y + MODULE_PX, x : x + MODULE_PX] = 0
    return img


def main():
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    det = cv2.QRCodeDetector()
    failures = 0
    for c in cases:
        decoded, _, _ = det.detectAndDecode(render(c["rows"]))
        ok = decoded == c["text"]
        failures += 0 if ok else 1
        print(
            f"{'ok  ' if ok else 'FAIL'}  v{c['version']} mask={c['mask']}  "
            f"{c['note']}"
        )
        if not ok:
            print(f"        wanted {c['text']!r}")
            print(f"        got    {decoded!r}")

    print()
    if failures:
        print(f"{failures} of {len(cases)} did not round-trip")
        return 1
    print(f"all {len(cases)} matrices decoded back to their input")
    return 0


if __name__ == "__main__":
    sys.exit(main())
