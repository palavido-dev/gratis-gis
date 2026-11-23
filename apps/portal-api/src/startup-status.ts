// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Startup progress for the status page.
 *
 * On the NAS stack, Caddy starts before everything else and shows a
 * status page whenever the portal does not answer. That page reads a
 * small JSON file this module writes, so a person who has never seen
 * a container log still learns what is happening: the database is
 * being updated, the portal is starting, or the start failed and why.
 *
 * Writes nothing unless GG_STATUS_FILE is set. The VPS stack, dev,
 * and an older pasted NAS file do not set it, so for them this is a
 * no-op. Writing is best effort: a full disk or a read-only mount
 * must never stop the portal from starting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Phases the status page knows how to describe. */
export const STARTUP_PHASES = [
  'starting',
  'database-check',
  'database-rebuild',
  'database-update',
  'app-starting',
  'ready',
  'failed',
] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];

export interface StartupStatus {
  phase: StartupPhase;
  /** Extra words for the page, for example the database being rebuilt. */
  detail?: string;
  /** For `failed`: the last lines of output, with secrets removed. */
  log?: string;
  /** When this start began (ISO 8601). Kept across phase changes. */
  since: string;
  /** When this file was written (ISO 8601). */
  updated: string;
  /** The previous start's failure, kept while the next start runs. */
  lastFailure?: { at: string; log?: string; detail?: string };
}

const MAX_LOG_LINES = 40;
const MAX_LOG_CHARS = 6000;

/** Env names whose values are secrets and must not reach the page. */
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|_KEY$|^KEY$|API_KEY|PRIVATE)/i;

/**
 * Remove secrets from text shown on an unauthenticated page: the
 * password in any `scheme://user:pass@host` URL, and the value of
 * every environment variable whose name says it is a secret.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s@/]+)@/gi, '$1$2:***@');
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 6)
    .map(([, value]) => value as string)
    // Longest first so a value that contains another is removed whole.
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join('***');
  }
  return out;
}

/** The last lines of a log, trimmed for the page. */
export function tailLines(text: string, lines = MAX_LOG_LINES): string {
  const kept = text
    // Colour codes from Nest's logger make the page unreadable.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n');
  return kept.length > MAX_LOG_CHARS ? kept.slice(-MAX_LOG_CHARS) : kept;
}

function readCurrent(file: string): StartupStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StartupStatus;
    return parsed && typeof parsed === 'object' && typeof parsed.phase === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export interface WriteOptions {
  detail?: string | undefined;
  log?: string | undefined;
  file?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/**
 * Record a phase. `starting` opens a new start: it resets `since` and,
 * when the previous start failed, keeps that failure as `lastFailure`
 * so the page can still show why while the retry runs.
 */
export function writeStartupStatus(phase: StartupPhase, opts: WriteOptions = {}): void {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env.GG_STATUS_FILE;
  if (!file) return;
  try {
    const now = (opts.now ?? new Date()).toISOString();
    const current = readCurrent(file);
    let since = current?.since ?? now;
    let lastFailure = current?.lastFailure;
    if (phase === 'starting') {
      since = now;
      if (current?.phase === 'failed') {
        lastFailure = { at: current.updated };
        if (current.log) lastFailure.log = current.log;
        if (current.detail) lastFailure.detail = current.detail;
      }
    }
    if (phase === 'ready') lastFailure = undefined;
    const status: StartupStatus = { phase, since, updated: now };
    if (opts.detail) status.detail = redact(opts.detail, env);
    if (opts.log) status.log = redact(tailLines(opts.log), env);
    if (lastFailure) status.lastFailure = lastFailure;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o644 });
    renameSync(tmp, file);
  } catch {
    // Best effort. See the header comment.
  }
}
