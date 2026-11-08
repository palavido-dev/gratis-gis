// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import {
  chmod,
  chown,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  SCRIPT_MAX_NOTEBOOK_BYTES,
  type ScriptFormat,
} from '@gratis-gis/shared-types';

export interface ExecuteRequest {
  source: string;
  /** The run's minted portal key. The only credential the child gets. */
  apiKeyToken: string;
  timeoutSeconds: number;
  maxLogBytes: number;
  /** `python` (default) or `notebook`. */
  format?: ScriptFormat;
  /** Largest executed notebook to hand back. */
  maxNotebookBytes?: number;
}

export interface ExecuteResult {
  exitCode: number | null;
  log: string;
  killedBy: 'timeout' | 'cancel' | null;
  /** The executed .ipynb, for a notebook run that produced one small
   *  enough to keep. Null otherwise. */
  notebook?: string | null;
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
  /**
   * Tail of the run queue. Every run waits for the one before it to
   * finish, including its uid sweep, before it starts.
   *
   * Every run executes as the same script uid, and a process of that
   * uid can read /proc/<pid>/environ of any other, which holds
   * GRATISGIS_API_KEY. So two runs must never be alive at once. The
   * claimer is meant to send one run at a time, but that is a property
   * of a different process. If a cancel ever fails to stop a child, or
   * a second claimer appears, the executor itself still refuses to let
   * a lingering process sit beside the next run's key.
   */
  private queue: Promise<void> = Promise.resolve();

  async execute(
    req: ExecuteRequest,
    /** Fires when the caller goes away, i.e. a cancel. */
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    try {
      await previous;
      return await this.executeAlone(req, signal);
    } finally {
      release();
    }
  }

  private async executeAlone(
    req: ExecuteRequest,
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    // A cancel that arrived while this run waited in the queue, or
    // before the abort listener below is attached, must not be lost.
    // A listener added to an already-aborted signal never fires.
    if (signal?.aborted) {
      return { exitCode: null, log: '', killedBy: 'cancel', notebook: null };
    }
    const asUser = scriptUser();
    // Nothing owned by the script uid may be alive when this run's key
    // is handed to a child. A leftover from an earlier run (a double
    // fork that escaped its process group, a cancel that raced) could
    // otherwise read the new key straight out of /proc.
    if (asUser && !(await this.sweepUid(asUser.uid))) {
      return {
        exitCode: null,
        log: 'A process from an earlier script run could not be stopped, so this run did not start.\n',
        killedBy: null,
        notebook: null,
      };
    }
    // Scratch under a directory owned by the script user, not shared
    // /tmp, so one run cannot plant a file another one picks up.
    const base = process.env.SCRIPT_TMPDIR ?? tmpdir();
    const dir = await mkdtemp(join(base, 'gg-script-'));
    const isNotebook = req.format === 'notebook';
    const file = join(dir, isNotebook ? 'main.ipynb' : 'main.py');
    // Where papermill writes the executed copy. Inside the run
    // directory, so the same teardown removes it and one run cannot
    // read another's outputs.
    const outFile = join(dir, 'executed.ipynb');
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
    if (asUser) {
      await chown(file, 0, asUser.gid);
      await chmod(file, 0o640);
      await chown(dir, 0, asUser.gid);
      await chmod(dir, 0o770);
    }

    let out = '';
    let truncated = false;

    try {
      // The awaits above give a cancel time to land. Check again so a
      // run cancelled during setup never starts.
      if (signal?.aborted) {
        return { exitCode: null, log: '', killedBy: 'cancel', notebook: null };
      }
      // A notebook goes through papermill rather than the interpreter.
      // Same one process, same uid, same limits, same kill: the only
      // difference is what reads the file.
      //
      // --log-output echoes each cell's stdout as it runs, so the plain
      // text log stays useful and a run that dies halfway shows how far
      // it got. Without it the output only exists inside a notebook
      // that a killed run never finishes writing.
      const command = isNotebook
        ? (process.env.SCRIPT_PAPERMILL ?? 'papermill')
        : (process.env.SCRIPT_PYTHON ?? 'python3');
      const args = isNotebook
        ? [file, outFile, '--log-output', '--no-progress-bar', '--cwd', dir]
        : // -I isolates: ignores PYTHON* env vars and the user site
          // directory, so the run cannot be steered by leftovers in
          // the image. -u keeps output unbuffered, because a killed
          // process must not lose the last thing it printed.
          ['-I', '-u', file];

      return await new Promise<ExecuteResult>((resolve) => {
        const child = spawn(
          command,
          args,
          {
            cwd: dir,
            env: this.childEnv(req.apiKeyToken, dir),
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
        // Belt and braces for the gap between the check above and the
        // listener: an abort in between would otherwise go unheard.
        if (signal?.aborted) onAbort();

        const done = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (!isNotebook) {
            resolve({ exitCode: code, log: out, killedBy, notebook: null });
            return;
          }
          // Read the executed notebook before the finally block wipes
          // the directory. Deliberately after a failure too: papermill
          // writes the notebook as it goes, so a cell that raised is
          // preserved with its traceback in place, which is the most
          // useful artifact a failed run can leave.
          void this.readNotebook(
            outFile,
            req.maxNotebookBytes ?? SCRIPT_MAX_NOTEBOOK_BYTES,
          ).then((notebook) => {
            resolve({ exitCode: code, log: out, killedBy, notebook });
          });
        };
        child.on('error', (err) => {
          out += `\nCould not start the script: ${err.message}\n`;
          done(null);
        });
        child.on('close', (code) => done(code));
      });
    } finally {
      // Kill anything the run left behind BEFORE removing its dir.
      //
      // hardKill() targets the child's process group, which a script can
      // escape with os.setsid() or a double fork: the orphan lands in a
      // new session that a negative-pid kill never reaches, and survives
      // until the container stops. Runs are serialised by the queue in
      // execute(), and only scripts run as the script uid, so after a
      // run finishes there should be zero processes owned by that uid.
      // Sweep them.
      if (asUser) await this.killByUid(asUser.uid);
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // A leftover temp dir is not worth failing a finished run.
      });
    }
  }

  /**
   * Kill everything owned by `uid` and confirm it is gone. Returns false
   * when processes are still listed after a few attempts, in which case
   * the caller must not start a new run.
   */
  private async sweepUid(uid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const killed = await this.killByUid(uid);
      if (killed === 0) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return (await this.killByUid(uid)) === 0;
  }

  /**
   * SIGKILL every process owned by `uid`. Best-effort. Returns how many
   * processes it found.
   *
   * Reads /proc rather than shelling out to pkill, which the slim image
   * does not ship. Needs CAP_KILL, which the executor holds precisely so
   * root can signal across the uid boundary to the script user; the
   * script itself never gets that capability. Safe to sweep the whole
   * uid because runs are serialised and no other process runs as it.
   */
  private async killByUid(uid: number): Promise<number> {
    let pids: string[];
    try {
      pids = (await readdir('/proc')).filter((p) => /^\d+$/.test(p));
    } catch {
      return 0; // Not Linux, or no /proc. Nothing to sweep.
    }
    let found = 0;
    for (const pid of pids) {
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        // "Uid:\treal\teffective\tsaved\tfs": match the real uid.
        const m = /^Uid:\s+(\d+)/m.exec(status);
        if (!m || Number(m[1]) !== uid) continue;
        // A zombie keeps its /proc entry until reaped but can no longer
        // run or read anything, so it does not count.
        if (/^State:\s+Z/m.test(status)) continue;
        found++;
        process.kill(Number(pid), 'SIGKILL');
        this.log.warn(
          `Killed leftover script process ${pid} (uid ${uid}) after the run.`,
        );
      } catch {
        // Process already gone between readdir and kill, or a status we
        // could not read. Either way it is not our concern now.
      }
    }
    return found;
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
  /**
   * The executed notebook, or null if there is nothing usable.
   *
   * Size-checked before reading rather than after: a notebook full of
   * plots is base64 PNG all the way down, and the point of a cap is not
   * to pull 200 MB into memory in order to decide it is too big.
   */
  private async readNotebook(
    path: string,
    maxBytes: number,
  ): Promise<string | null> {
    try {
      const info = await stat(path);
      if (info.size > maxBytes) {
        this.log.warn(
          `Executed notebook is ${info.size} bytes, over the ${maxBytes} limit; keeping the log only.`,
        );
        return null;
      }
      return await readFile(path, 'utf8');
    } catch {
      // No notebook: the run was killed before papermill wrote one, or
      // the source was not a notebook at all. The log still stands on
      // its own, so this is not worth failing the run over.
      return null;
    }
  }

  childEnv(apiKeyToken: string, runDir?: string): NodeJS.ProcessEnv {
    // Everything writable points at the per-run directory, which lives on
    // the size-capped tmpfs (SCRIPT_TMPDIR) and is deleted when the run
    // ends. That is what lets the executor container run `read_only` with
    // no uncapped writable path: HOME, the temp dir, and every cache dir
    // below resolve into this one bounded, disposable place.
    //
    // Before this, HOME defaulted to /tmp and TMPDIR was unset, so
    // Python's tempfile wrote to /tmp on the container's writable overlay
    // (the host disk), with no quota. A `open('/tmp/x','wb')` loop could
    // fill the host filesystem and take postgres and the site down. The
    // tmpfs only ever covered the scratch dir; this makes it cover
    // everything a run can write.
    const home = runDir ?? process.env.SCRIPT_HOME ?? '/tmp';
    return {
      GRATISGIS_URL: process.env.PORTAL_BASE_URL ?? 'http://localhost:3000',
      GRATISGIS_API_KEY: apiKeyToken,
      // Enough of a system for python to start and for TLS to verify.
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      // Point every temp path at the capped run dir. TMPDIR/TMP/TEMP
      // cover tempfile and most libraries; the others cover tools that
      // read their own env.
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // Parity with the plain-python `-I` flag for the notebook path,
      // which papermill runs without it: ignore any per-user site dir so
      // a run cannot be steered by leftovers under a writable HOME.
      PYTHONNOUSERSITE: '1',
      ...(process.env.SSL_CERT_FILE
        ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
        : {}),
      ...(process.env.SSL_CERT_DIR
        ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR }
        : {}),
      // Jupyter writes connection files, a runtime directory, and an
      // IPython profile the first time a kernel starts. Left to
      // themselves they land under HOME, which persists between runs
      // and would be a channel from one run to the next. Pointing them
      // at the run directory keeps a kernel's litter inside the thing
      // that gets deleted when the run ends.
      ...(runDir
        ? {
            JUPYTER_RUNTIME_DIR: join(runDir, '.jupyter-runtime'),
            JUPYTER_DATA_DIR: join(runDir, '.jupyter-data'),
            IPYTHONDIR: join(runDir, '.ipython'),
            // matplotlib does the same thing with its font cache.
            MPLCONFIGDIR: join(runDir, '.matplotlib'),
          }
        : {}),
    };
  }
}

/**
 * The identity a script runs as, distinct from the executor's own.
 *
 * Two cases, and the split is a security control, not a convenience:
 *
 *   Not root (local dev): the executor is an ordinary user who cannot
 *   setuid to anyone, so we return null and the child runs as the
 *   developer. Fine on a laptop.
 *
 *   Root (the container): the uid drop is the ONLY thing standing
 *   between the child and /proc/1/environ, which holds the executor
 *   token. If SCRIPT_UID/SCRIPT_GID are missing or bogus here we must
 *   REFUSE, not fall through to running the child as root. The previous
 *   version returned null in that case, silently handing an untrusted
 *   script the executor's own privileges and its secret. Failing the
 *   run loudly is the safe direction; a single env slip should break
 *   scripts, not quietly un-sandbox them.
 */
function scriptUser(): { uid: number; gid: number } | null {
  const privileged =
    typeof process.getuid === 'function' && process.getuid() === 0;
  if (!privileged) return null;

  const uid = Number(process.env.SCRIPT_UID);
  const gid = Number(process.env.SCRIPT_GID);
  const valid =
    Number.isInteger(uid) && Number.isInteger(gid) && uid > 0 && gid > 0;
  if (!valid) {
    throw new Error(
      'Executor is running as root but SCRIPT_UID/SCRIPT_GID are not set ' +
        'to a valid non-root uid/gid. Refusing to run: this is the control ' +
        'that stops a script reading the executor token off /proc.',
    );
  }
  return { uid, gid };
}
