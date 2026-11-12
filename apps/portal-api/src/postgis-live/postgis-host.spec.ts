// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  assertPostgisHost,
  assertPostgisHostOnSave,
  postgisHostBlockReason,
} from './postgis-host.js';

describe('postgisHostBlockReason', () => {
  it('allows a LAN address and a normal hostname', () => {
    expect(postgisHostBlockReason('192.168.1.20')).toBeNull();
    expect(postgisHostBlockReason('db.example.org')).toBeNull();
    expect(postgisHostBlockReason('100.64.1.2')).toBeNull();
    expect(postgisHostBlockReason('gisdb')).toBeNull();
  });

  it('refuses loopback, link-local, metadata, and stack service names', () => {
    expect(postgisHostBlockReason('127.0.0.1')).toBe('blocked-address');
    expect(postgisHostBlockReason('0.0.0.0')).toBe('blocked-address');
    expect(postgisHostBlockReason('169.254.169.254')).toBe('blocked-address');
    expect(postgisHostBlockReason('[::1]')).toBe('blocked-address');
    expect(postgisHostBlockReason('fe80::1')).toBe('blocked-address');
    expect(postgisHostBlockReason('localhost')).toBe('loopback');
    expect(postgisHostBlockReason('postgres')).toBe('stack-service');
    expect(postgisHostBlockReason('Keycloak')).toBe('stack-service');
  });
});

describe('postgisHostBlockReason with other IPv6 spellings', () => {
  it.each([
    '0:0:0:0:0:0:0:1',
    '[0:0:0:0:0:0:0:1]',
    '::ffff:7f00:1',
    '[::ffff:a9fe:a9fe]',
    '::ffff:127.0.0.1',
  ])('refuses %s', (host) => {
    expect(postgisHostBlockReason(host)).toBe('blocked-address');
  });

  it('still allows a LAN address written as v4-mapped hex', () => {
    expect(postgisHostBlockReason('::ffff:c0a8:0105')).toBeNull();
  });
});

describe('assertPostgisHost', () => {
  it('refuses a name when any DNS answer is link-local', async () => {
    await expect(
      assertPostgisHost('rebind.example', async () => [
        { address: '1.2.3.4' },
        { address: '169.254.169.254' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a name that resolves to a LAN address', async () => {
    await expect(
      assertPostgisHost('db.lan', async () => [{ address: '10.1.2.3' }]),
    ).resolves.toBeUndefined();
  });
});

describe('assertPostgisHostOnSave', () => {
  it('leaves an unchanged host alone, even a stack service name', async () => {
    const data = { protocol: 'postgis_live', host: 'postgres' };
    await expect(
      assertPostgisHostOnSave(data, data, async () => {
        throw new Error('lookup should not run');
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses changing the host onto a stack service', async () => {
    await expect(
      assertPostgisHostOnSave(
        { protocol: 'postgis_live', host: '192.168.1.20' },
        { protocol: 'postgis_live', host: 'minio' },
        async () => [{ address: '1.2.3.4' }],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
