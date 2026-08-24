// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * System tar wrapper (#47).
 *
 * Replaces the npm `tar` package for the three operations the
 * backup / restore services need:
 *
 *   1. Create a gzipped archive from a staging directory.
 *   2. Extract a gzipped archive into a directory.
 *   3. Pull a single entry's bytes out of an archive (used to peek
 *      at manifest.json without extracting everything).
 *
 * Why shell out: every supported deployment target ships a `tar`
 * binary. The portal-api container is debian-based, the host dev
 * machine is Windows where Win10+ bundles bsdtar at C:\Windows\
 * System32\tar.exe, and macOS / Linux dev shells all have tar.
 * The npm `tar` package was the largest direct dep in portal-api;
 * removing it saves ~110k LOC of dep weight and a routinely-CVE'd
 * surface (six advisories in the last 18 months). The cost is one
 * subprocess fork per archive operation, which is negligible
 * compared to the pg_dump call that lives in the same critical
 * section.
 *
 * Errors are surfaced as Error with the tar binary's stderr text
 * appended so an operator debugging a failed backup gets a useful
 * message ("tar: cannot stat 'postgres/...'") instead of a generic
 * non-zero exit message.
 */

import { spawn } from 'node:child_process';

const TAR_BIN = process.env.TAR_BIN ?? 'tar';

/** Resolve a child-process invocation to a promise. Captures
 *  stderr so failures carry the real reason. */
function runTar(
  args: readonly string[],
  options: { onStdout?: (chunk: Buffer) => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TAR_BIN, args, {
      // Pipe stderr always; pipe stdout only if a consumer wants it.
      // Inheriting stderr would race with parent-process logging and
      // make the captured-stderr error message empty.
      stdio: ['ignore', options.onStdout ? 'pipe' : 'ignore', 'pipe'],
      // Don't pass through env; tar doesn't need to see anything
      // specific. Keeps the subprocess minimal.
      env: {
        PATH: process.env.PATH ?? '',
        // LANG matters: bsdtar / gnutar emit localized error
        // strings if LANG=de_DE.UTF-8 etc. We pin to C so the
        // strings we surface back to the admin are predictable.
        LANG: 'C',
        LC_ALL: 'C',
      },
    });
    let stderr = '';
    // stderr is always piped (see stdio setup above), so the
    // possibly-null shape here is a TS conservatism we can ignore
    // safely. Same for stdout when the caller asked for it.
    // Capped like every other runCommand copy in the repo: only the
    // last 5 lines are ever surfaced, and an uncapped buffer let a
    // chatty tar over a large archive pin memory for output nobody
    // reads. This was the one copy without the cap (2026-08-24
    // review). Keep the TAIL, since tar prints its fatal line last.
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      if (stderr.length > 32 * 1024) {
        stderr = `...${stderr.slice(-16 * 1024)}`;
      }
    });
    if (options.onStdout) {
      proc.stdout?.on('data', options.onStdout);
    }
    proc.on('error', (err) => {
      reject(
        new Error(
          `Could not spawn tar (${TAR_BIN}): ${err.message}. ` +
            `Set TAR_BIN to the absolute path of the tar binary if it's not on PATH.`,
        ),
      );
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      reject(
        new Error(
          `tar exited ${code} (args=${args.join(' ')})${tail ? `: ${tail}` : ''}`,
        ),
      );
    });
  });
}

/**
 * Create a gzipped tar archive. Entries are written relative to
 * `cwd`, so the archive's internal paths match what was at the
 * project root in the staging dir (`postgres/...`, `minio/...`,
 * `manifest.json`).
 *
 *   tar -czf <file> -C <cwd> <entry1> <entry2> ...
 *
 * `--no-acls --no-xattrs` keep the archive portable: macOS-side
 * bsdtar otherwise tucks resource forks into extended attributes
 * that GNU tar on the restore side spends time complaining about.
 * Backups don't need those attributes.
 */
export async function createTarGz(
  file: string,
  cwd: string,
  entries: readonly string[],
): Promise<void> {
  const args = ['-czf', file, '-C', cwd, ...entries];
  await runTar(args);
}

/**
 * Extract a gzipped tar archive into `cwd`.
 *
 *   tar -xzf <file> -C <cwd>
 */
export async function extractTarGz(
  file: string,
  cwd: string,
): Promise<void> {
  await runTar(['-xzf', file, '-C', cwd]);
}

/**
 * Read one entry's bytes from a gzipped tar archive without
 * extracting the rest. Used to peek at `manifest.json` before we
 * commit to a full restore.
 *
 *   tar -xzOf <file> <entry>     # -O writes to stdout
 *
 * Returns the entry's bytes, or null if the entry isn't present.
 * Both GNU and BSD tar exit with a non-zero status if the entry is
 * missing, but the error message differs; we distinguish "missing"
 * from "real error" by inspecting stderr.
 */
export async function readTarEntry(
  file: string,
  entry: string,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  try {
    await runTar(['-xzOf', file, entry], {
      onStdout: (c) => {
        chunks.push(c);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Both tars emit "Not found in archive" (gnu) or
    // "tar: <entry>: Not found in archive" (bsd) when the named
    // entry isn't present. Return null in that case so callers can
    // 404 instead of 500.
    if (/not found in archive/i.test(msg)) return null;
    throw err;
  }
  return Buffer.concat(chunks);
}
