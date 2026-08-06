// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';

/**
 * Rate limiting needs to recognise "this address again". It does not
 * need to know the address. Storing a keyed hash gives the first
 * without the second, so a portal that collects a few hundred polite
 * bug reports is not also quietly accumulating a list of who was
 * browsing it and when.
 *
 * The salt comes from FEEDBACK_IP_SALT. When it is unset we mint a
 * random one per process rather than falling back to a constant:
 * a hardcoded salt is barely better than no salt, because the input
 * space (IPv4) is small enough to enumerate completely in seconds, so
 * an unsalted or publicly-salted hash is reversible by brute force and
 * is therefore still personal data.
 *
 * The cost of a per-process salt is that rate-limit history does not
 * carry across a restart, and the two API replicas count separately.
 * That is a real weakening, which is why the env var exists and why
 * the deployed portal sets it. It is the safer default of the two:
 * a forgotten env var costs some rate-limit accuracy rather than
 * silently retaining recoverable IP addresses.
 */
let cachedSalt: string | null = null;

function salt(): string {
  if (cachedSalt !== null) return cachedSalt;
  const configured = process.env.FEEDBACK_IP_SALT?.trim();
  cachedSalt = configured && configured.length > 0
    ? configured
    : randomBytes(32).toString('hex');
  return cachedSalt;
}

/** Test seam: forget the memoized salt so a spec can set the env var. */
export function resetIpSaltForTests(): void {
  cachedSalt = null;
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(`${salt()}:${ip}`).digest('hex');
}
