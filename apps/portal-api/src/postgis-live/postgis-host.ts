// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which hosts a new PostGIS Live connection may use.
 *
 * A self-hosted portal's normal target is a database on the LAN, so
 * RFC1918 and Tailscale (CGNAT) addresses stay allowed. What is not
 * allowed is the portal talking to itself: loopback, link-local
 * (cloud metadata lives in 169.254.0.0/16), multicast, and the
 * Compose service names of this stack. An existing saved connection
 * is left alone when its host does not change, so an upgrade does
 * not drop a database that was already working.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

import { BadRequestException } from '@nestjs/common';

/** Service names this compose stack uses. A short LAN hostname that
 *  is not in this set is still allowed. */
const STACK_HOSTS = new Set([
  'postgres',
  'keycloak',
  'minio',
  'portal-api',
  'portal-web',
  'portal-worker',
  'pointcloud-worker',
  'caddy',
  'chromium',
  'chromium-1',
  'chromium-2',
  'pg_tileserv',
  'nominatim',
  'bootstrap',
  'script-runner',
  'script-executor',
]);

export type HostLookup = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

const defaultLookup: HostLookup = async (host) => {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers;
};

/**
 * Why a host must not be used, or null when it is fine. Synchronous:
 * no DNS. Callers that have a hostname still need
 * `assertPostgisHost` so a name that resolves to a blocked address
 * is refused too.
 */
export function postgisHostBlockReason(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return 'empty';
  if (trimmed === 'localhost' || trimmed.endsWith('.localhost')) {
    return 'loopback';
  }
  if (STACK_HOSTS.has(trimmed)) return 'stack-service';
  const ip = unwrapIp(trimmed);
  if (ip !== null && isBlockedAddress(ip)) return 'blocked-address';
  return null;
}

/**
 * Refuse a new connection target. DNS failures are reported as
 * "could not resolve" rather than the resolver's own text.
 */
export async function assertPostgisHost(
  host: string,
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  const reason = postgisHostBlockReason(host);
  if (reason) throw new BadRequestException(REFUSAL);
  const trimmed = host.trim();
  // A literal address was already classified above.
  if (unwrapIp(trimmed.toLowerCase()) !== null) return;
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await lookup(trimmed);
  } catch {
    throw new BadRequestException('That host could not be resolved.');
  }
  if (answers.length === 0) {
    throw new BadRequestException('That host could not be resolved.');
  }
  for (const answer of answers) {
    const address = answer.address.toLowerCase();
    if (isBlockedAddress(unwrapIp(address) ?? address)) {
      throw new BadRequestException(REFUSAL);
    }
  }
}

const REFUSAL =
  "That host is not allowed. Use the database's own address. " +
  "Loopback, link-local, and this portal's own services are refused.";

/**
 * When a service item is saved, check the host only if it changed.
 * An unchanged host keeps working after an upgrade, including one
 * that would not be accepted for a brand-new connection.
 */
export async function assertPostgisHostOnSave(
  previous: unknown,
  next: unknown,
  lookup?: HostLookup,
): Promise<void> {
  const nextHost = readHost(next);
  if (nextHost === null) return;
  if (readProtocol(next) !== 'postgis_live' && readProtocol(previous) !== 'postgis_live') {
    // A service item that is not PostGIS Live. Host fields on other
    // protocols are not this check's problem.
    if (readProtocol(next) !== 'postgis_live') return;
  }
  if (readProtocol(next) !== 'postgis_live') return;
  const prevHost = readProtocol(previous) === 'postgis_live' ? readHost(previous) : null;
  if (prevHost !== null && prevHost.toLowerCase() === nextHost.toLowerCase()) return;
  await assertPostgisHost(nextHost, lookup);
}

function readProtocol(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const protocol = (data as { protocol?: unknown }).protocol;
  return typeof protocol === 'string' ? protocol : null;
}

function readHost(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const host = (data as { host?: unknown }).host;
  return typeof host === 'string' && host.trim().length > 0 ? host.trim() : null;
}

function unwrapIp(host: string): string | null {
  let value = host;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (isIpv4(value)) return value;
  if (value.includes(':')) return canonicalIpv6(value);
  return null;
}

/**
 * The one spelling URL gives an IPv6 literal, so `0:0:0:0:0:0:0:1`
 * reads as `::1`, and a v4-mapped address in hex (`::ffff:7f00:1`)
 * comes back as its dotted IPv4 form. Without this the classifier
 * only knew a few spellings and the rest passed.
 */
function canonicalIpv6(value: string): string {
  const zoneless = value.split('%')[0] ?? value;
  let canonical: string;
  try {
    canonical = new URL(`http://[${zoneless}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return value;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return canonical;
}

function isIpv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isBlockedAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  const bare = address.toLowerCase();
  if (bare === '::1' || bare === '::') return true;
  // fe80::/10. The first group is fe80 through febf.
  const head = bare.split('%')[0]?.split(':')[0] ?? '';
  if (/^fe[89ab][0-9a-f]$/.test(head)) return true;
  // ff00::/8 multicast.
  if (/^ff[0-9a-f]{2}$/.test(head)) return true;
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (dotted && dotted[1] && isBlockedAddress(dotted[1])) return true;
  return false;
}

/**
 * An SRID is interpolated into SQL (`ST_Transform(..., <srid>)`), so
 * it must be a plain positive integer. EPSG codes and PostGIS
 * spatial_ref_sys ids all fit well under the bound.
 */
export function isValidSrid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 999_999
  );
}

/**
 * On save of a PostGIS Live service item, refuse a layer whose `srid`
 * is not a plain positive integer. The read path checks again, so a
 * row saved before this check cannot inject SQL either.
 */
export function assertPostgisLayersOnSave(next: unknown): void {
  if (readProtocol(next) !== 'postgis_live') return;
  const layers = (next as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const srid = (layer as { srid?: unknown }).srid;
    // 0 (or null) is what PostGIS reports for a geometry column with
    // no declared SRID. It is not injectable and must not block saving
    // the rest of the item; reading that layer is refused instead.
    if (srid === undefined || srid === null || srid === 0) continue;
    if (!isValidSrid(srid)) {
      throw new BadRequestException('Each layer srid must be a positive whole number.');
    }
  }
}
