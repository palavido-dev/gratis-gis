// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  assertPostgisHost,
  assertPostgisHostOnSave,
  currentHostDenials,
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

describe('own interface addresses and the operator deny list (17-9)', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1' }],
    eth0: [{ address: '172.18.0.5' }, { address: 'fd00::5' }],
  } as never;

  it('refuses the API container own addresses but not the rest of its range', () => {
    const denials = currentHostDenials({}, interfaces);
    expect(postgisHostBlockReason('172.18.0.5', denials)).toBe('denied');
    expect(postgisHostBlockReason('[fd00::5]', denials)).toBe('denied');
    expect(postgisHostBlockReason('172.18.0.6', denials)).toBeNull();
    expect(postgisHostBlockReason('192.168.1.20', denials)).toBeNull();
  });

  it('refuses names, addresses and IPv4 ranges from POSTGIS_LIVE_DENY_HOSTS', () => {
    const denials = currentHostDenials(
      { POSTGIS_LIVE_DENY_HOSTS: ' gg_default , 10.9.9.9, 172.20.0.0/16 ,bad/99' },
      {} as never,
    );
    expect(postgisHostBlockReason('GG_default', denials)).toBe('denied');
    expect(postgisHostBlockReason('10.9.9.9', denials)).toBe('denied');
    expect(postgisHostBlockReason('172.20.4.1', denials)).toBe('denied');
    expect(postgisHostBlockReason('172.21.0.1', denials)).toBeNull();
  });

  it('refuses a name that resolves to an own address', async () => {
    const denials = currentHostDenials({}, interfaces);
    await expect(
      assertPostgisHost('postgres.gg_default', async () => [{ address: '172.18.0.5' }], denials),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertPostgisHost('gisdb.lan', async () => [{ address: '192.168.1.20' }], denials),
    ).resolves.toBeUndefined();
  });
});

describe('POSTGIS_LIVE_ALLOW_HOSTS (host-network installs)', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1' }],
    eth0: [{ address: '192.168.1.10' }],
  } as never;

  it('exempts a listed address or name from the own-address rule', async () => {
    const denials = currentHostDenials(
      { POSTGIS_LIVE_ALLOW_HOSTS: '192.168.1.10, gisbox.lan' },
      interfaces,
    );
    expect(postgisHostBlockReason('192.168.1.10', denials)).toBeNull();
    await expect(
      assertPostgisHost('gisbox.lan', async () => [{ address: '192.168.1.10' }], {
        ...currentHostDenials({ POSTGIS_LIVE_ALLOW_HOSTS: 'gisbox.lan' }, interfaces),
      }),
    ).resolves.toBeUndefined();
  });

  it('still refuses the own address when it is not listed', () => {
    const denials = currentHostDenials({}, interfaces);
    expect(postgisHostBlockReason('192.168.1.10', denials)).toBe('denied');
  });

  it('never exempts loopback or a deny-list entry', () => {
    const denials = currentHostDenials(
      {
        POSTGIS_LIVE_ALLOW_HOSTS: '127.0.0.1,10.0.0.5',
        POSTGIS_LIVE_DENY_HOSTS: '10.0.0.5',
      },
      interfaces,
    );
    expect(postgisHostBlockReason('127.0.0.1', denials)).toBe('blocked-address');
    expect(postgisHostBlockReason('10.0.0.5', denials)).toBe('denied');
  });
});
