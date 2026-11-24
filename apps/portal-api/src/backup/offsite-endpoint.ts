// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Which off-site endpoints the portal will talk to.
 *
 * - https only, unless BACKUP_OFFSITE_ALLOW_HTTP=true in the server
 *   environment. The admin page cannot turn that on, and it applies to
 *   endpoints set by environment variable too.
 * - Never this server itself, link-local addresses or cloud metadata
 *   services, unless BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT=true (for a
 *   test store on the same machine). Private network ranges such as
 *   10.0.0.0/8 stay allowed: a store on the LAN is a real use.
 *
 * The name is checked as written, and again after DNS when the portal
 * connects, so a name that points at a refused address is refused too.
 */

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

export interface EndpointPolicy {
  allowHttp: boolean;
  allowLocal: boolean;
}

function flag(env: (n: string) => string | undefined, name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env(name) ?? '').trim().toLowerCase());
}

export function endpointPolicy(
  env: (n: string) => string | undefined = (n) => process.env[n],
): EndpointPolicy {
  return {
    allowHttp: flag(env, 'BACKUP_OFFSITE_ALLOW_HTTP'),
    allowLocal: flag(env, 'BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT'),
  };
}

const refused = new BlockList();
refused.addSubnet('0.0.0.0', 8, 'ipv4');
refused.addSubnet('127.0.0.0', 8, 'ipv4');
refused.addSubnet('169.254.0.0', 16, 'ipv4');
// Alibaba Cloud metadata.
refused.addAddress('100.100.100.200', 'ipv4');
refused.addAddress('::', 'ipv6');
refused.addAddress('::1', 'ipv6');
refused.addSubnet('fe80::', 10, 'ipv6');
// AWS metadata over IPv6.
refused.addAddress('fd00:ec2::254', 'ipv6');

const REFUSED_NAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** True when the address is one the portal must not send backups to. */
export function isRefusedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return refused.check(address, 'ipv4');
  if (kind === 6) {
    const lower = address.toLowerCase();
    // IPv4 written inside IPv6 (::ffff:127.0.0.1) is the IPv4 address.
    const mapped = /^(?:0*:)*:?(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return refused.check(mapped[1]!, 'ipv4');
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return refused.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return refused.check(address, 'ipv6');
  }
  return false;
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/**
 * Check an endpoint as written. Throws a plain sentence the page can
 * show; returns the normalised URL text.
 */
export function checkEndpoint(text: string, policy: EndpointPolicy): string {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    throw new EndpointError(
      'The endpoint must be a full URL, such as https://s3.eu-central-003.backblazeb2.com.',
    );
  }
  if (u.protocol === 'http:') {
    if (!policy.allowHttp) {
      throw new EndpointError(
        'The endpoint must use https. Plain http is allowed only when the server sets BACKUP_OFFSITE_ALLOW_HTTP=true.',
      );
    }
  } else if (u.protocol !== 'https:') {
    throw new EndpointError('The endpoint must use https.');
  }
  if (u.username || u.password) {
    throw new EndpointError('Put the keys in their own fields, not in the endpoint URL.');
  }
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) {
    throw new EndpointError(
      'The endpoint is the server address only, without a path. Put the bucket name in the bucket field.',
    );
  }
  const host = hostOf(u);
  if (!policy.allowLocal && (REFUSED_NAMES.has(host) || host.endsWith('.localhost') || isRefusedAddress(host))) {
    throw new EndpointError(
      'The endpoint cannot be this server, a link-local address or a cloud metadata address.',
    );
  }
  return `${u.protocol}//${u.host}`;
}

/**
 * Resolve the endpoint's name and refuse it when any address it gives
 * is refused. Run before every connection.
 */
export async function assertEndpointReachable(
  text: string,
  policy: EndpointPolicy,
  lookup: (host: string) => Promise<Array<{ address: string }>> = (h) =>
    dnsLookup(h, { all: true, verbatim: true }),
): Promise<void> {
  checkEndpoint(text, policy);
  if (policy.allowLocal) return;
  const host = hostOf(new URL(text.trim()));
  if (isIP(host)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    // Let the S3 client report the DNS failure in its own words.
    return;
  }
  if (addresses.some((a) => isRefusedAddress(a.address))) {
    throw new EndpointError(
      'The endpoint name points at this server, a link-local address or a cloud metadata address, so it is refused.',
    );
  }
}
