// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared SSRF guards used by every probe path that takes a
 * user-supplied URL and fetches it server-side (basemap probe,
 * geocoder probe, ArcGIS service probe, item proxy, public proxy,
 * tile-layer ingest worker).
 *
 * `isPrivateOrLoopbackHost` returns true for hostnames that should
 * never be the target of a server-side fetch from inside the prod
 * docker network: numeric RFC1918, loopback, link-local, IPv6
 * loopback / unique-local, `localhost`, and any bare single-label
 * hostname (which in our deploy is always a docker compose service
 * name like `postgres`, `keycloak`, `minio`, `pg_tileserv`).
 *
 * `assertSafeOutboundUrl` is the load-bearing helper: it parses the
 * URL, rejects non-http(s) schemes, runs the hostname check, and
 * then resolves the hostname via DNS and re-runs the check against
 * the resolved IP.  Without the post-DNS check, an attacker can
 * register a public hostname that resolves to 192.168.x.y and
 * smuggle a fetch past a hostname-only filter.
 *
 * `safeFetch` is a drop-in replacement for `fetch()` that runs the
 * assert step first.  Every outbound HTTP call originating from a
 * user-supplied URL must route through `safeFetch`.  Outbound calls
 * to fixed, deploy-time-configured URLs (Keycloak's token endpoint,
 * MinIO inside the docker network) do NOT need the guard and would
 * trip on the single-label hostname check; they call `fetch()`
 * directly.
 *
 * The TCP connect uses only the addresses that check already
 * accepted. The URL hostname is left in place so TLS SNI and the
 * certificate check still use that name, not the IP. A later DNS
 * answer cannot move the socket. Admin-configured local model hosts
 * (loopback, RFC1918, single-label docker names) stay on plain
 * fetch in the AI client and are not blocked here.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | PinnedAddress[],
  family?: number,
) => void;

/**
 * The addresses `resolveSafe` already accepted. Used by tests to
 * show a later DNS answer is not what we dial.
 */
export function answerPinnedLookup(
  list: PinnedAddress[] | undefined,
  options: unknown,
  callback: LookupCallback,
): void {
  if (!list || list.length === 0) {
    const err = new Error('no pinned address') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    callback(err, '');
    return;
  }
  const all =
    typeof options === 'object' &&
    options !== null &&
    'all' in options &&
    (options as { all?: boolean }).all === true;
  if (all) {
    callback(null, list);
    return;
  }
  const first = list[0];
  if (!first) {
    const err = new Error('no pinned address') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    callback(err, '');
    return;
  }
  callback(null, first.address, first.family);
}

/**
 * The dial target. An IPv4 address is rebuilt from the octets that
 * passed the private-range check, so the socket host is that number
 * and not the caller-supplied URL string.
 */
export function connectHost(address: string): string {
  if (isPrivateOrLoopbackHost(address)) {
    throw new UnsafeOutboundUrlError(`private address: ${address}`);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const nums = v4.slice(1).map((part) => Number(part));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new UnsafeOutboundUrlError(`bad address: ${address}`);
    }
    const rebuilt = `${nums[0]}.${nums[1]}.${nums[2]}.${nums[3]}`;
    if (isPrivateOrLoopbackHost(rebuilt)) {
      throw new UnsafeOutboundUrlError(`private address: ${rebuilt}`);
    }
    return rebuilt;
  }
  if (!/^[0-9a-f:]+$/i.test(address)) {
    throw new UnsafeOutboundUrlError(`bad address: ${address}`);
  }
  return address;
}

export function isPrivateOrLoopbackHost(host: string): boolean {
  // Numeric IPv4. Block RFC1918 + loopback + link-local.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [, a, b] = m;
    const aN = Number(a);
    const bN = Number(b);
    // 0.0.0.0/8 ("this network").  0.0.0.0 in particular connects
    // to the local host on Linux (the kernel treats it like
    // 127.0.0.1), so it is loopback in every way that matters.
    if (aN === 0) return true;
    if (aN === 10) return true;
    if (aN === 127) return true;
    if (aN === 169 && bN === 254) return true;
    if (aN === 172 && bN >= 16 && bN <= 31) return true;
    if (aN === 192 && bN === 168) return true;
    // Carrier-grade NAT (RFC 6598).  Not strictly necessary today
    // but cheap to add and matches the spirit of the rule.
    if (aN === 100 && bN >= 64 && bN <= 127) return true;
    // Multicast and reserved (224.0.0.0/4 and above, including
    // 255.255.255.255).
    if (aN >= 224) return true;
    return false;
  }
  // IPv6.  URL parsing wraps v6 hosts in brackets while DNS-lookup
  // results come back bare, so strip the brackets and run one set
  // of checks over both spellings.
  let v6 = host;
  if (v6.startsWith('[') && v6.endsWith(']')) v6 = v6.slice(1, -1);
  if (v6.includes(':')) {
    const bare = v6.toLowerCase();
    // Loopback, plus the unspecified address (the v6 spelling of
    // 0.0.0.0, which likewise lands on the local host).
    if (bare === '::1' || bare === '::') return true;
    // Unique-local fc00::/7.
    if (bare.startsWith('fc') || bare.startsWith('fd')) return true;
    // Link-local fe80::/10 and multicast ff00::/8. The first group
    // is enough: fe80-febf, and ff00-ffff.
    const head = bare.split('%')[0]?.split(':')[0] ?? '';
    if (/^fe[89ab][0-9a-f]$/.test(head)) return true;
    if (/^ff[0-9a-f]{2}$/.test(head)) return true;
    // IPv4-mapped addresses (::ffff:a.b.c.d, or the equivalent
    // hex groups ::ffff:aabb:ccdd).  The socket connects to the
    // embedded IPv4 address, so the IPv4 rules decide; without
    // this mapping, [::ffff:127.0.0.1] walks straight past the
    // checks above.  Only a private verdict short-circuits here:
    // public mapped forms still fall through to the hostname
    // heuristics below so this stays a strictly tightening check.
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
    if (dotted && isPrivateOrLoopbackHost(dotted[1] ?? '')) return true;
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
    if (hex) {
      const hi = parseInt(hex[1] ?? '0', 16);
      const lo = parseInt(hex[2] ?? '0', 16);
      const quad = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (isPrivateOrLoopbackHost(quad)) return true;
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const lower = host.toLowerCase();
  if (
    lower === 'metadata.google.internal' ||
    lower.endsWith('.metadata.google.internal')
  ) {
    return true;
  }
  // Short numeric forms such as 127.1 and bare decimals. They are
  // not public names, and some stacks treat them as IPv4.
  if (/^\d+(\.\d+){0,2}$/.test(host)) return true;
  // Any bare single-label hostname in our prod deploy is a docker
  // compose service name and must not be fetched from a
  // user-supplied URL.  Real external services always have FQDNs.
  if (!host.includes('.') && !host.startsWith('[')) return true;
  return false;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to fetch URL: ${reason}`);
    this.name = 'UnsafeOutboundUrlError';
  }
}

/**
 * Validate a user-supplied URL for server-side fetch.  Throws
 * `UnsafeOutboundUrlError` if the URL targets a private host, an
 * unresolvable host, or a non-HTTP scheme.  Returns the parsed
 * URL on success.
 *
 * Performs two checks:
 *   1. Hostname-as-given is not in the private ranges
 *   2. DNS lookup of the hostname resolves to a non-private IP
 * The second is the DNS-rebinding defense.
 */
async function resolveSafe(
  rawUrl: string,
): Promise<{ url: URL; addresses: PinnedAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError(
      `unsupported scheme: ${url.protocol}`,
    );
  }
  const host = url.hostname;
  if (isPrivateOrLoopbackHost(host)) {
    throw new UnsafeOutboundUrlError(`private host: ${host}`);
  }
  // One public address beside a private one is still a private host.
  let answers: Array<{ address: string; family: number }>;
  try {
    const resolved = await dnsLookup(host, { all: true, verbatim: true });
    answers = Array.isArray(resolved) ? resolved : [resolved];
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) throw e;
    throw new UnsafeOutboundUrlError(`unresolvable host: ${host}`);
  }
  if (answers.length === 0) {
    throw new UnsafeOutboundUrlError(`unresolvable host: ${host}`);
  }
  const addresses: PinnedAddress[] = [];
  for (const { address, family } of answers) {
    if (isPrivateOrLoopbackHost(address)) {
      throw new UnsafeOutboundUrlError(
        `host ${host} resolves to private IP ${address}`,
      );
    }
    addresses.push({ address, family: family === 6 ? 6 : 4 });
  }
  return { url, addresses };
}

export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  return (await resolveSafe(rawUrl)).url;
}

/** Statuses the fetch spec treats as followable redirects. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Redirect-hop ceiling for safeFetch.  Deep chains on probe-style
 * traffic are either misconfiguration or an attempt to burn our
 * request budget; legitimate services settle in one or two hops.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Headers that describe a request body.  Dropped when a redirect
 * downgrades the method to GET, per the fetch spec's
 * request-body-header list.
 */
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-length',
  'content-type',
];

/**
 * Credential-bearing headers.  Stripped when a redirect leaves the
 * origin we validated, mirroring what undici's own redirect
 * handling does, so a hostile Location target cannot harvest them.
 */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

/**
 * Drop-in replacement for `fetch()` that validates the URL before
 * dispatching.  Use this for every outbound HTTP call originating
 * from a user-supplied URL.
 *
 * Redirects are followed manually, up to MAX_REDIRECT_HOPS, with
 * every Location re-validated through `assertSafeOutboundUrl`
 * before it is fetched.  The runtime's built-in `redirect:
 * 'follow'` would only validate the first URL: a public host that
 * 302s to http://169.254.169.254/ would be followed with no check,
 * which defeats the whole guard.  Callers that pass `redirect:
 * 'manual'` or `'error'` keep that behavior (no unchecked follow
 * can happen on either).
 *
 * For fixed, deploy-time URLs (the Keycloak token endpoint via
 * AUTH_URL env, MinIO inside the docker network) call `fetch`
 * directly; those URLs target single-label hostnames or internal
 * IPs by design and would trip the guard.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
): Promise<Response> {
  // Caller opted out of following ('manual' returns the 3xx as-is,
  // 'error' makes fetch throw on it); neither can hop to an
  // unchecked host, so a single validated dispatch suffices.
  if (init?.redirect === 'manual' || init?.redirect === 'error') {
    const pinned = await resolveSafe(rawUrl);
    return connectPinned(pinned, init);
  }

  let pinned = await resolveSafe(rawUrl);
  let currentUrl = pinned.url;
  let method = (init?.method ?? 'GET').toUpperCase();
  // Typed via RequestInit['body'] so we don't depend on the DOM
  // lib's BodyInit name (portal-api compiles with node types only);
  // undefined is the "no body" sentinel, matching fetch's own
  // semantics.  On a method downgrade we clear it back to that.
  let body: RequestInit['body'] = init?.body ?? undefined;
  const headers = new Headers(init?.headers);

  for (let hop = 0; ; hop++) {
    // Build the per-hop init explicitly: exactOptionalPropertyTypes
    // forbids handing fetch a `body: undefined`, so set it only
    // when present.
    const hopInit: RequestInit = {
      ...init,
      method,
      headers,
      redirect: 'manual',
    };
    if (body === undefined || body === null) {
      delete hopInit.body;
    } else {
      hopInit.body = body;
    }
    const res = await connectPinned(pinned, hopInit);
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    // Redirect status without a Location is not followable; hand
    // it back like fetch itself would.
    if (!location) return res;
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new UnsafeOutboundUrlError(
        `too many redirects (limit ${MAX_REDIRECT_HOPS}) fetching ${rawUrl}`,
      );
    }
    let nextRaw: string;
    try {
      // Location may be relative; resolve against the hop that
      // issued it.
      nextRaw = new URL(location, currentUrl).toString();
    } catch {
      throw new UnsafeOutboundUrlError(`invalid redirect Location: ${location}`);
    }
    const nextPinned = await resolveSafe(nextRaw);
    const nextUrl = nextPinned.url;
    // We won't read this hop's body; release it so the connection
    // can be reused instead of idling until timeout.
    try {
      await res.body?.cancel();
    } catch {
      /* already errored or consumed; nothing to release */
    }
    // Method rewrite per the fetch spec: 303 always downgrades to
    // GET; 301/302 do too when the request was a POST.  307/308
    // preserve method and body.
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      for (const h of BODY_HEADERS) headers.delete(h);
    }
    if (nextUrl.origin !== currentUrl.origin) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    }
    currentUrl = nextUrl;
    pinned = nextPinned;
  }
}

type PinnedTransport = (
  url: URL,
  init: RequestInit | undefined,
  addresses: PinnedAddress[],
) => Promise<Response>;

/**
 * Dial the checked address, not the name in the URL. `servername`
 * keeps TLS SNI and certificate hostname verification on the name
 * the caller asked for. The socket host is `connectHost(address)`.
 */
function nodePinnedRequest(
  url: URL,
  init: RequestInit | undefined,
  addresses: PinnedAddress[],
): Promise<Response> {
  const chosen = addresses[0];
  if (!chosen) throw new UnsafeOutboundUrlError('no pinned address');
  const host = connectHost(chosen.address);
  const lib = url.protocol === 'https:' ? https : http;
  const headers = new Headers(init?.headers);
  headers.set('host', url.host);
  const path = `${url.pathname}${url.search}`;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method: init?.method ?? 'GET',
        path,
        headers: Object.fromEntries(headers.entries()),
        servername: url.hostname,
        rejectUnauthorized: true,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') responseHeaders.append(key, value);
          else if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          }
        }
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(
          new Response(body, {
            status: incoming.statusCode ?? 0,
            headers: responseHeaders,
          }),
        );
      },
    );
    const onAbort = () => req.destroy();
    init?.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', reject);
    req.on('close', () => init?.signal?.removeEventListener('abort', onAbort));
    const body = init?.body;
    if (body == null) {
      req.end();
      return;
    }
    if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
      req.end(body);
      return;
    }
    req.end();
  });
}

let transport: PinnedTransport = nodePinnedRequest;

/** Tests substitute a fake dial. Production uses `nodePinnedRequest`. */
export function _setSafeFetchTransportForTests(next: PinnedTransport | null): void {
  transport = next ?? nodePinnedRequest;
}

function connectPinned(
  pinned: { url: URL; addresses: PinnedAddress[] },
  init: RequestInit | undefined,
): Promise<Response> {
  return transport(pinned.url, init, pinned.addresses);
}
