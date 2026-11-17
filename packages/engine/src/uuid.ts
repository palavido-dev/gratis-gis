// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UUIDv7 generator. Postgres 16 does not ship a native `uuidv7()` function
// (Postgres 17 does, and the `pg_uuidv7` extension covers older versions),
// so we generate ids in app code on the write path. The format follows
// RFC 9562 section 5.7:
//
//   ttttttttttttttttttttttttvvvvxxxxxxxxxxxxxx...
//   |---48 bit unix ms------||4 bit version  ||62 bit random + 2 bit variant|
//
// The 48-bit timestamp is the Unix epoch in milliseconds.
//
// Ids from one process are strictly increasing (RFC 9562 section 6.2,
// method 2, "monotonic random"). Within one millisecond, or if the clock
// steps back, the 74 random bits are the previous id's plus a random
// step instead of fresh random bits. Readers order observations by
// (tx_time, id), and tx_time has millisecond precision, so without this
// a delete followed by a re-create in the same millisecond sorted in
// random order and the re-created feature could read as deleted.
// Ids from different processes still interleave at random within a
// millisecond; nothing on the write path depends on that order.

import { randomBytes } from 'node:crypto';

const RAND_BITS = 74n;
const RAND_MAX = (1n << RAND_BITS) - 1n;

let lastTs = -1n;
let lastRand = 0n;

function randomBig(bytes: number): bigint {
  return BigInt(`0x${randomBytes(bytes).toString('hex')}`);
}

/**
 * Generate a UUIDv7 as a lowercase string with dashes.
 *
 * @param now Optional override for the timestamp, used by tests. An
 *   explicit timestamp is used as given and does not take part in the
 *   monotonic sequence.
 */
export function uuidv7(now?: number): string {
  let ts: bigint;
  let rand: bigint;
  if (now !== undefined) {
    ts = BigInt(now);
    rand = randomBig(10) & RAND_MAX;
  } else {
    ts = BigInt(Date.now());
    if (ts > lastTs) {
      rand = randomBig(10) & RAND_MAX;
    } else {
      // Same millisecond, or the clock went back: keep the previous
      // timestamp and step the random bits forward by 1 to 2^32.
      ts = lastTs;
      rand = lastRand + 1n + randomBig(4);
      if (rand > RAND_MAX) {
        ts += 1n;
        rand = randomBig(10) & RAND_MAX;
      }
    }
    lastTs = ts;
    lastRand = rand;
  }
  return format(ts, rand);
}

/** Lay out a 48-bit timestamp and 74 random bits as RFC 9562 UUIDv7. */
function format(ts: bigint, rand: bigint): string {
  const randA = (rand >> 62n) & 0xfffn; // 12 bits
  const randB = rand & ((1n << 62n) - 1n); // 62 bits
  const out = Buffer.alloc(16);
  for (let i = 0; i < 6; i += 1) {
    out[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  out[6] = 0x70 | Number(randA >> 8n); // version 7
  out[7] = Number(randA & 0xffn);
  out[8] = 0x80 | Number((randB >> 56n) & 0x3fn); // variant 10
  for (let i = 9; i < 16; i += 1) {
    out[i] = Number((randB >> BigInt(8 * (15 - i))) & 0xffn);
  }
  const hex = out.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Extract the timestamp encoded in a UUIDv7 string. Returns `null` if the
 * input is not a UUIDv7 (wrong version field).
 */
export function uuidv7Timestamp(uuid: string): number | null {
  const stripped = uuid.replace(/-/g, '');
  if (stripped.length !== 32) return null;
  // Version nibble is the 13th hex digit (zero-indexed 12).
  if (stripped[12] !== '7') return null;
  const tsHex = stripped.slice(0, 12);
  return Number.parseInt(tsHex, 16);
}

/**
 * RFC 9562 UUID format check: 8-4-4-4-12 hex with dashes. Does not validate
 * the version or variant fields.
 */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
