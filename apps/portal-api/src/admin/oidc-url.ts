// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { assertSafeOutboundUrl } from '../common/net-guards.js';

/**
 * Sign-in endpoints Keycloak will call. Public https only: an
 * admin must not be able to point the realm at a link-local or
 * loopback address.
 *
 * The string checks below missed many forms (a trailing dot,
 * v4-mapped IPv6, the rest of 169.254/16, ULA, CGNAT, a stack
 * service name, a public name that resolves to a private address).
 * So the host must also be a dotted name, and it goes through the
 * same resolve-and-check that every other outbound URL uses.
 */
export async function assertPublicHttps(raw: string): Promise<string> {
  const url = assertHttpsShape(raw);
  try {
    await assertSafeOutboundUrl(url);
  } catch {
    throw new BadRequestException('That host is not a public sign-in service.');
  }
  return url;
}

function assertHttpsShape(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Enter an https URL.');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('The sign-in URLs must use https.');
  }
  // A trailing dot names the same host ("localhost." is localhost).
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.replace(/\.+$/, '');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Single-label names are LAN or Compose service names.
  if (!host.includes('.') && !host.includes(':')) {
    throw new BadRequestException('That host is not a public sign-in service.');
  }
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '169.254.169.254' ||
    host.startsWith('10.') ||
    host.startsWith('127.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.startsWith('fe80:') ||
    host === '::1'
  ) {
    throw new BadRequestException('That host is not a public sign-in service.');
  }
  return url.toString();
}

const ALIAS = /^[a-z][a-z0-9-]{0,40}$/;

export function assertAlias(raw: string): string {
  const alias = raw.trim().toLowerCase();
  if (!ALIAS.test(alias)) {
    throw new BadRequestException(
      'The alias must be lowercase letters, numbers, and hyphens.',
    );
  }
  return alias;
}
