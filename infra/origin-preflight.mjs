// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tell an operator why sign-in will refuse the host they opened.
 * Does not change GRATIS_ANALYSIS or any other default.
 */
export function suggestedBaseUrl(openedHost) {
  const hostname = openedHost.split(':')[0] ?? openedHost;
  const hasPort = openedHost.includes(':');
  if (hostname.endsWith('.ts.net') && !hasPort) return `https://${hostname}`;
  if (!openedHost) return '';
  return `http://${openedHost}`;
}

export function decideOrigin(openedHost, configured) {
  const canonical = (configured ?? '').trim().replace(/\/$/, '');
  let allowedHost = '';
  try {
    if (canonical) allowedHost = new URL(canonical).host;
  } catch {
    allowedHost = '';
  }
  const allowed =
    !canonical ||
    !openedHost ||
    openedHost.toLowerCase() === allowedHost.toLowerCase();
  const lines = [];
  if (!allowed) {
    lines.push(
      `Sign-in will not start. This browser opened ${openedHost}, and the portal is configured for ${allowedHost}.`,
    );
    if ((openedHost.split(':')[0] ?? '').endsWith('.ts.net')) {
      lines.push(
        'Tailscale Serve presents its own name. Set GRATIS_BASE_URL to that https name and restart. Keep the volumes.',
      );
    } else {
      lines.push(
        'Set GRATIS_BASE_URL to the address you actually open, then restart. A LAN address and a Tailscale name are different origins.',
      );
    }
    lines.push(`GRATIS_BASE_URL: ${suggestedBaseUrl(openedHost)}`);
  }
  return { allowed, lines, suggested: suggestedBaseUrl(openedHost) };
}

function cli() {
  const opened = process.argv[2] ?? '';
  const configured = process.argv[3] ?? process.env.GRATIS_BASE_URL ?? '';
  const decision = decideOrigin(opened, configured);
  for (const line of decision.lines) console.log(line);
  if (!decision.allowed) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
