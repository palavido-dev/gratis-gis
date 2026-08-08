// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { chmod, chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

export interface ExecuteRequest {
  source: string;
  /** The run's minted portal key. The only credential the child gets. */
  apiKeyToken: string;
  timeoutSeconds: number;
  maxLogBytes: number;
}

export interface ExecuteResult {
  exitCode: number | null;
  log: string;
  killedBy: 'timeout' | 'cancel' | null;
}

/**
 * Spawns the Python. This is the only code in the portal that runs
 * something the portal did not write.
 *
 * It lives in its own process and its own container on purpose (see
 * script-executor.main.ts). The container it runs in has no database
 * credentials and sits on a network that cannot reach postgres,
 * object storage, or Keycloak, so "what can this process reach" is
 * answered by Docker rather than by this file being careful.
 *
 * That matters because the environment scrub below, good as it is,
 * only controls what the child can READ. It does nothing about what
 * the child can CONNECT to. A script in the previous single-container
 * design could open a socket to postgres:5432 with no credentials;
 * verified, not theorised. Credentials were never the whole story.
 */
@Injectable()
export class ScriptExecutorService {
  private readonly log = new Logger(ScriptExecutorService.name);

  async execute(
    req: ExecuteRequest,
    /** Fires when the caller goes away, i.e. a cancel. */
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    // Scratch under a directory owned by the script user, not shared
    // /tmp, so one run cannot plant a file another one picks up.
    const base = process.env.SCRIPT_TMPDIR ?? tmpdir();
    const dir = await mkdtemp(join(base, 'gg-script-'));
    const file = join(dir, 'main.py');
    await writeFile(file, req.source, 'utf8');
    // The child runs as a different user, so it must be able to read
    // its own source and write into its own scratch directory.
    // Share the run directory by GROUP rather than handing it over.
    //
    // The obvious version, chown the directory to the script user, does
    // not work here and the failure is instructive. Root in this
    // container has no CAP_DAC_OVERRIDE, so it is an ordinary user for
    // permission checks. Once the directory belonged to uid 10001 with
    // mkdtemp's default 0700, root could no longer chdir into it, and
    // spawn failed with EACCES before the child ever started. It was
    // the cwd, not the uid: the same spawn with cwd=/tmp worked.
    //
    // So: directory stays owned by root, group is the script group,
    // mode 0770. Root can enter it and clean it up afterwards; the
    // child can read, write, and enter it through the group bit.
    // Removing files the child created works because unlink is
    // governed by permission on the DIRECTORY, which root owns.
    //
    // The source file is group-readable and not writable by the child:
    // a script has no business rewriting the record of what ran.
    //
    // Not caught: if this fails the child cannot read its own source
    // and would die somewhere confusing, so a clear error here is
    // better.
    const asUser = scriptUser();
    if (asUser) {
      await chown(file, 0, asUser.gid);
      await chmod(file, 0o640);
      await chown(dir, 0, asUser.gid);
      await chmod(dir, 0o770);
    }

    let out = '';
    let truncated = false;

    try {
      return await new Promise<ExecuteResult>((resolve) => {
        const child = spawn(
          process.env.SCRIPT_PYTHON ?? 'python3',
          // -I isolates: ignores PYTHON* env vars and the user site
          // directory, so the run cannot be steered by leftovers in
          // the image. -u keeps output unbuffered, because a killed
          // process must not lose the last thing it printed.
          ['-I', '-u', file],
          {
            cwd: dir,
            env: this.childEnv(req.apiKeyToken),
            stdio: ['ignore', 'pipe', 'pipe'],
            // Drop to the dedicated script identity. Without this the
            // child shares the executor's UID and can read
            // /proc/1/environ, which defeats the scrub above and hands
            // it the executor's token. Measured, not theorised.
            //
            // Also puts the child in its own process group, so a kill
            // reaches anything it spawned rather than only the
            // interpreter.
            ...(asUser ? { uid: asUser.uid, gid: asUser.gid } : {}),
            detached: true,
          },
        );

        let settled = false;
        let killedBy: 'timeout' | 'cancel' | null = null;

        const collect = (buf: Buffer) => {
          if (truncated) return;
          out += buf.toString('utf8');
          if (out.length > req.maxLogBytes) {
            out = out.slice(0, req.maxLogBytes);
            truncated = true;
            // Say so. A log that just stops reads as a crash, and the
            // author goes looking for the wrong bug.
            out += '\n--- output truncated at the size limit ---\n';
          }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const hardKill = () => {
          // SIGKILL, not SIGTERM: a script can install a SIGTERM
          // handler, and a timeout a script may decline to honour is
          // not a timeout.
          //
          // Negative pid kills the whole process GROUP. A script that
          // spawns helpers would otherwise leave them running after
          // the interpreter dies, which is how a timeout turns into a
          // permanent background process.
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Group already gone; fall through to the direct kill.
          }
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        };

        const timer = setTimeout(() => {
          killedBy = 'timeout';
          hardKill();
        }, req.timeoutSeconds * 1000);
        timer.unref();

        const onAbort = () => {
          killedBy = 'cancel';
          hardKill();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const done = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode: code, log: out, killedBy });
        };
        child.on('error', (err) => {
          out += `\nCould not start the script: ${err.message}\n`;
          done(null);
        });
        child.on('close', (code) => done(code));
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // A leftover temp dir is not worth failing a finished run.
      });
    }
  }

  /**
   * The child's entire environment, built from nothing.
   *
   * Allowlist, not denylist. Passing `...process.env` minus a
   * hand-maintained deny set means the next secret someone adds to
   * compose is exposed to every script until somebody remembers to
   * add it to the list. Starting empty means the next secret is
   * private by default and the mistake is a missing variable, which
   * is loud.
   *
   * GRATISGIS_URL and GRATISGIS_API_KEY are exactly the names
   * `GratisGIS.from_env()` reads. That is a contract shared with
   * everyone who exports them on their own machine, so the spec
   * checks them against the client's source rather than a literal.
   */
  childEnv(apiKeyToken: string): NodeJS.ProcessEnv {
    return {
      GRATISGIS_URL: process.env.PORTAL_BASE_URL ?? 'http://localhost:3000',
      GRATISGIS_API_KEY: apiKeyToken,
      // Enough of a system for python to start and for TLS to verify.
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.SCRIPT_HOME ?? '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      ...(process.env.SSL_CERT_FILE
        ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
        : {}),
      ...(process.env.SSL_CERT_DIR
        ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR }
        : {}),
    };
  }
}

/**
 * The identity a script runs as, distinct from the executor's own.
 *
 * Absent in local development, where the executor runs as an ordinary
 * user who cannot setuid to anyone. The container sets both, and the
 * compose service grants exactly SETUID and SETGID for this.
 *
 * Returning null rather than guessing matters: spawning with a bogus
 * uid throws EPERM and every run fails, which is a worse outcome than
 * a dev machine running the child as the developer.
 */
function scriptUser(): { uid: number; gid: number } | null {
  const uid = Number(process.env.SCRIPT_UID);
  const gid = Number(process.env.SCRIPT_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  if (uid <= 0 || gid <= 0) return null;
  // Only meaningful if we are privileged enough to change user at all.
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return null;
  }
  return { uid, gid };
}
