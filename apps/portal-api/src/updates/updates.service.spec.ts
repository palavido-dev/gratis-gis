// SPDX-License-Identifier: AGPL-3.0-or-later
import { UpdatesService } from './updates.service.js';

const KEYS = [
  'UPDATE_CHECK',
  'GG_VERSION',
  'GIT_SHA',
  'GG_CHANNEL',
  'GG_IMAGE_TAG',
  'INSTALL_TYPE',
  'GRATIS_COMPOSE_REV',
  'REQUIRED_COMPOSE_REV',
  'GITHUB_REPOSITORY',
] as const;

describe('UpdatesService', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) saved.set(key, process.env[key]);
    delete process.env.GG_IMAGE_TAG;
    delete process.env.GITHUB_REPOSITORY;
    process.env.GG_VERSION = 'v1.1.0-2-gabc1234';
    process.env.GIT_SHA = 'abc1234def567890';
    process.env.GG_CHANNEL = 'edge';
    process.env.INSTALL_TYPE = 'nas';
    process.env.GRATIS_COMPOSE_REV = '1';
    process.env.REQUIRED_COMPOSE_REV = '1';
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  it.each(['off', '0', 'false'])(
    'UPDATE_CHECK=%s returns current info and does not call out',
    async (flag) => {
      process.env.UPDATE_CHECK = flag;
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const report = await new UpdatesService().status();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report.offline).toBe(false);
      expect(report.latest).toBeNull();
      expect(report.updateAvailable).toBe(false);
      expect(report.channel).toBe('edge');
      expect(report.installType).toBe('nas');
      expect(report.current).toEqual({
        version: 'v1.1.0-2-gabc1234',
        gitSha: 'abc1234def567890',
        composeRev: '1',
      });
      expect(report.composeOutdated).toBe(false);
    },
  );

  it('still reports an outdated NAS compose file when checks are off', async () => {
    process.env.UPDATE_CHECK = 'off';
    process.env.REQUIRED_COMPOSE_REV = '2';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const report = await new UpdatesService().status();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.composeOutdated).toBe(true);
    expect(report.latest).toBeNull();
  });

  it('stays quiet when GitHub cannot be reached', async () => {
    process.env.UPDATE_CHECK = 'on';
    process.env.GG_CHANNEL = 'latest';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const report = await new UpdatesService().status();
    expect(report.offline).toBe(true);
    expect(report.latest).toBeNull();
    expect(report.updateAvailable).toBe(false);
    expect(report.current.version).toBe('v1.1.0-2-gabc1234');
  });

  it('retries a failed check after minutes, not after six hours', async () => {
    process.env.UPDATE_CHECK = 'on';
    process.env.GG_CHANNEL = 'latest';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const svc = new UpdatesService();
    await svc.status();
    await svc.status();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
    await svc.status();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
