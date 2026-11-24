// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from 'node:dns';
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
 * The name is checked as written, and again after DNS before each
 * upload. The S3 client also checks every address it is about to
 * connect to (guardedLookup), so a name that starts pointing at a
 * refused address between the check and the connection is refused too.
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

/** The 16 bytes of an IPv6 address, or null when it does not parse. */
export function ipv6Bytes(address: string): Buffer | null {
  let text = address.toLowerCase().replace(/%.*$/, '');
  // A trailing dotted IPv4 part becomes two hex groups.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.writeUInt16BE(parseInt(g, 16), i * 2);
  }
  return out;
}

/**
 * The IPv4 address carried inside an IPv6 one, for the forms that
 * reach an IPv4 host: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible
 * (::a.b.c.d, also written ::7f00:1), the well-known NAT64 prefix
 * 64:ff9b::/96 and the local-use NAT64 prefix 64:ff9b:1::/48.
 */
export function embeddedIpv4(address: string): string | null {
  const b = ipv6Bytes(address);
  if (!b) return null;
  const zero = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4;
  // ::/96. Also :: and ::1, which land in 0.0.0.0/8 and are refused.
  if (zero(0, 12)) return v4;
  if (b.readUInt32BE(0) === 0x0064ff9b && zero(4, 12)) return v4;
  if (b.readUInt32BE(0) === 0x0064ff9b && b.readUInt16BE(4) === 1) return v4;
  return null;
}

/** True when the address is one the portal must not send backups to. */
export function isRefusedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return refused.check(address, 'ipv4');
  if (kind === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return refused.check(v4, 'ipv4');
    return refused.check(address, 'ipv6');
  }
  return false;
}

const REFUSED_AFTER_DNS =
  'The endpoint name points at this server, a link-local address or a cloud metadata address, so it is refused.';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A DNS lookup for the S3 client's connections that refuses an answer
 * holding a refused address. It runs on the very lookup the connection
 * uses, so there is no gap between the check and the use.
 */
export function guardedLookup(
  policy: EndpointPolicy,
  lookup: typeof dnsLookupCb = dnsLookupCb,
): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options }, ((
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => {
      if (err || policy.allowLocal) return callback(err, address, family);
      const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (all.some((a) => isRefusedAddress(a))) {
        return callback(
          Object.assign(new Error(REFUSED_AFTER_DNS), { code: 'EOFFSITEREFUSED' }),
          Array.isArray(address) ? [] : '',
        );
      }
      return callback(null, address, family);
    }) as never);
  };
}

function hostOf(u: URL): string {
  return u.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
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
  if (
    !policy.allowLocal &&
    (REFUSED_NAMES.has(host) || host.endsWith('.localhost') || isRefusedAddress(host))
  ) {
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
    throw new EndpointError(REFUSED_AFTER_DNS);
  }
}
