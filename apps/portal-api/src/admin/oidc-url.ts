// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Sign-in endpoints Keycloak will call. Public https only: an
 * admin must not be able to point the realm at a link-local or
 * loopback address.
 */
export function assertPublicHttps(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Enter an https URL.');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('The sign-in URLs must use https.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
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
