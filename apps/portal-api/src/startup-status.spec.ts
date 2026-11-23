// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redact, tailLines, writeStartupStatus, type StartupStatus } from './startup-status.js';

describe('startup status', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-status-'));
    file = join(dir, 'api.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (): StartupStatus => JSON.parse(readFileSync(file, 'utf8')) as StartupStatus;

  it('writes nothing without GG_STATUS_FILE', () => {
    writeStartupStatus('starting', { env: {} });
    expect(existsSync(file)).toBe(false);
  });

  it('records the phase and keeps since across phases', () => {
    const env = { GG_STATUS_FILE: file };
    writeStartupStatus('starting', { env, now: new Date('2026-11-22T10:00:00Z') });
    writeStartupStatus('database-rebuild', {
      env,
      detail: 'gratisgis',
      now: new Date('2026-11-22T10:01:00Z'),
    });
    const s = read();
    expect(s.phase).toBe('database-rebuild');
    expect(s.detail).toBe('gratisgis');
    expect(s.since).toBe('2026-11-22T10:00:00.000Z');
    expect(s.updated).toBe('2026-11-22T10:01:00.000Z');
  });

  it('keeps the last failure while the next start runs, and clears it when ready', () => {
    const env = { GG_STATUS_FILE: file };
    writeStartupStatus('failed', { env, log: 'Error: boom', now: new Date('2026-11-22T10:00:00Z') });
    writeStartupStatus('starting', { env, now: new Date('2026-11-22T10:00:10Z') });
    expect(read().lastFailure).toEqual({ at: '2026-11-22T10:00:00.000Z', log: 'Error: boom' });
    writeStartupStatus('database-update', { env });
    expect(read().lastFailure?.log).toBe('Error: boom');
    writeStartupStatus('ready', { env });
    expect(read().lastFailure).toBeUndefined();
  });

  it('removes secrets before anything reaches the page', () => {
    const env = { GG_STATUS_FILE: file, POSTGRES_PASSWORD: 's3cret-pass', NEXTAUTH_SECRET: 'abcdefgh' };
    writeStartupStatus('failed', {
      env,
      log: 'connect postgresql://gratisgis:s3cret-pass@postgres:5432/gratisgis failed\nkey abcdefgh',
    });
    const log = read().log ?? '';
    expect(log).not.toContain('s3cret-pass');
    expect(log).not.toContain('abcdefgh');
    expect(log).toContain('postgresql://gratisgis:***@postgres');
  });

  it('redact leaves short and non-secret values alone', () => {
    expect(redact('port 5432 user gratisgis', { DB_USER: 'gratisgis', PG_PASSWORD: 'abc' })).toBe(
      'port 5432 user gratisgis',
    );
  });

  it('tailLines keeps the last lines and strips colour codes', () => {
    const text = Array.from({ length: 60 }, (_, i) => `\u001b[31mline ${i}\u001b[39m`).join('\n');
    const out = tailLines(text, 3);
    expect(out).toBe('line 57\nline 58\nline 59');
  });

  it('never throws when the file cannot be written', () => {
    expect(() =>
      writeStartupStatus('starting', { env: { GG_STATUS_FILE: '/proc/nope/api.json' } }),
    ).not.toThrow();
  });
});
