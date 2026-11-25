// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs open-geocode inside portal-worker: downloads the chosen
 * extracts, builds the pack, and keeps `open-geocode serve` running as
 * a child process. open-geocode reads its pack once at start, so the
 * server is restarted after every build.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Logger } from '@nestjs/common';

import { isGeofabrikPbfUrl, type GeocoderRegion } from './geocoder-settings.js';

const USER_AGENT = 'GratisGIS (https://github.com/palavido-dev/gratis-gis)';

export interface GeocoderPaths {
  bin: string;
  dir: string;
  port: number;
}

export function geocoderPaths(env: NodeJS.ProcessEnv = process.env): GeocoderPaths {
  const port = Number(env.GEOCODER_PORT);
  return {
    bin: env.OPEN_GEOCODE_BIN?.trim() || '/usr/local/bin/open-geocode',
    dir: env.GEOCODER_DIR?.trim() || '/var/lib/gratis/geocoder',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8091,
  };
}

/** File name for one region's extract: the id with anything odd replaced. */
export function extractFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]+/g, '_')}.osm.pbf`;
}

/** Arguments for `open-geocode pack build`. */
export function buildArgs(
  inputs: string[],
  packDir: string,
  opts: { tiger: boolean; openAddresses: boolean; memoryBudgetMb: number },
): string[] {
  const args = ['pack', 'build'];
  for (const input of inputs) args.push('--input', input);
  args.push('--pack', packDir, '--fresh', '--memory-budget-mb', String(opts.memoryBudgetMb));
  if (opts.tiger) args.push('--tiger');
  if (opts.openAddresses) args.push('--openaddresses');
  return args;
}

/**
 * Split a stream of process output into lines. open-geocode redraws
 * its progress with carriage returns; each redraw counts as a line.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = '';
  return (chunk: string) => {
    const parts = (rest + chunk).split(/\r\n|\r|\n/);
    rest = parts.pop() ?? '';
    for (const part of parts) {
      // eslint-disable-next-line no-control-regex
      const clean = part.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
      if (clean.length > 0) onLine(clean);
    }
  };
}

export class GeocoderRunner {
  private readonly log = new Logger(GeocoderRunner.name);
  private server: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(readonly paths: GeocoderPaths = geocoderPaths()) {}

  get packDir(): string {
    return join(this.paths.dir, 'pack');
  }

  /** True when the open-geocode binary is on this image. */
  async available(): Promise<boolean> {
    try {
      await access(this.paths.bin, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** True when a built pack is on disk. */
  async hasPack(): Promise<boolean> {
    try {
      await access(join(this.packDir, 'CURRENT'));
      return true;
    } catch {
      return false;
    }
  }

  /** Size of the pack being served, in bytes. */
  async packBytes(): Promise<number | null> {
    try {
      const id = (await readFile(join(this.packDir, 'CURRENT'), 'utf8')).trim();
      const s = await stat(join(this.packDir, 'generations', id, 'pack.ogp'));
      return s.size;
    } catch {
      return null;
    }
  }

  /** Start serving the pack, if there is one and nothing is serving yet. */
  async startServer(): Promise<boolean> {
    if (this.server || !(await this.hasPack())) return false;
    this.stopping = false;
    const child = spawn(
      this.paths.bin,
      ['serve', '--pack', this.packDir, '--bind', `0.0.0.0:${this.paths.port}`, '--job-dir', join(this.paths.dir, 'jobs')],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.server = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on(
      'data',
      lineSplitter((line) => this.log.debug(`open-geocode: ${line}`)),
    );
    child.on('exit', (code, signal) => {
      if (this.server === child) this.server = null;
      if (this.stopping) return;
      this.log.warn(`open-geocode server stopped (code ${code}, signal ${signal}); restarting in 5 s.`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.startServer();
      }, 5_000);
    });
    this.log.log(`open-geocode serving ${this.packDir} on port ${this.paths.port}.`);
    return true;
  }

  async stopServer(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.server;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.server = null;
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  /** Download one extract to the input folder. Returns its path. */
  async download(
    region: GeocoderRegion,
    onProgress: (bytes: number, total: number | null) => void,
  ): Promise<string> {
    if (!isGeofabrikPbfUrl(region.pbfUrl)) {
      throw new Error(`Not a Geofabrik extract: ${region.pbfUrl}`);
    }
    const inputDir = join(this.paths.dir, 'input');
    await mkdir(inputDir, { recursive: true });
    const target = join(inputDir, extractFileName(region.id));
    const part = `${target}.part`;
    const res = await fetch(region.pbfUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.url && !isGeofabrikPbfUrl(res.url)) {
      await res.body?.cancel();
      throw new Error(`Download of ${region.name} was redirected off Geofabrik`);
    }
    if (!res.ok || !res.body) {
      throw new Error(`Download of ${region.name} failed: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length'));
    let bytes = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      onProgress(bytes, Number.isFinite(total) && total > 0 ? total : null);
    });
    await pipeline(body, createWriteStream(part));
    await rename(part, target);
    return target;
  }

  /** Run `open-geocode pack build`. Resolves on success, rejects with the last lines on failure. */
  build(
    args: string[],
    env: Record<string, string>,
    onLine: (line: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tail: string[] = [];
      const push = (line: string) => {
        tail.push(line);
        if (tail.length > 5) tail.shift();
        onLine(line);
      };
      const child = spawn(this.paths.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', HOME: this.paths.dir, ...env },
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', lineSplitter(push));
      child.stderr?.on('data', lineSplitter(push));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(tail.join('\n') || `open-geocode exited with code ${code}`));
      });
    });
  }

  /** Remove downloaded extracts and pack generations that are not served. */
  async tidy(): Promise<void> {
    await rm(join(this.paths.dir, 'input'), { recursive: true, force: true });
    try {
      const current = (await readFile(join(this.packDir, 'CURRENT'), 'utf8')).trim();
      const gens = await readdir(join(this.packDir, 'generations'));
      for (const g of gens) {
        if (g !== current) {
          await rm(join(this.packDir, 'generations', g), { recursive: true, force: true });
        }
      }
    } catch {
      /* nothing to tidy */
    }
  }
}
