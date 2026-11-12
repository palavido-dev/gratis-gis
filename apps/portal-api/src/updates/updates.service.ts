// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import {
  breakingLines,
  channelFromImageTag,
  composeOutdated,
  edgeUpdateAvailable,
  installTypeFromEnv,
  stableUpdateAvailable,
  unreleasedSection,
  type InstallType,
  type UpdateIdentity,
} from './updates-logic.js';

const CACHE_MS = 6 * 60 * 60 * 1000;
/** A failed check is retried after this long instead of after CACHE_MS. */
const FAILED_CACHE_MS = 5 * 60 * 1000;
const REPO = process.env.GITHUB_REPOSITORY || 'palavido-dev/gratis-gis';

export interface UpdateReport {
  current: {
    version: string;
    gitSha: string | null;
    composeRev: string | null;
  };
  latest: {
    version: string | null;
    gitSha: string | null;
  } | null;
  channel: string;
  releaseNotesUrl: string | null;
  composeOutdated: boolean;
  installType: InstallType;
  updateAvailable: boolean;
  breaking: string[];
  /** True when the check was skipped or the network call failed. */
  offline: boolean;
}

interface CacheEntry {
  at: number;
  /** How long this entry is reused. */
  ttl: number;
  report: UpdateReport;
}

function blank(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function checksEnabled(): boolean {
  const raw = (process.env.UPDATE_CHECK ?? 'on').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

@Injectable()
export class UpdatesService {
  private readonly log = new Logger(UpdatesService.name);
  private cache: CacheEntry | null = null;

  identity(): UpdateIdentity {
    const tag = process.env.GG_IMAGE_TAG?.trim() || '';
    const channel =
      blank(process.env.GG_CHANNEL) ??
      (tag ? channelFromImageTag(tag) : 'dev');
    return {
      version:
        process.env.GG_VERSION?.trim() ||
        process.env.npm_package_version ||
        'dev',
      gitSha: blank(process.env.GIT_SHA),
      composeRev: blank(process.env.GRATIS_COMPOSE_REV),
      requiredComposeRev: blank(process.env.REQUIRED_COMPOSE_REV),
      channel,
      installType: installTypeFromEnv(process.env.INSTALL_TYPE),
    };
  }

  async status(): Promise<UpdateReport> {
    const id = this.identity();
    if (!checksEnabled()) {
      return this.localOnly(id);
    }
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cache.ttl) {
      return this.cache.report;
    }
    let report: UpdateReport;
    let ttl = CACHE_MS;
    try {
      report = await this.fetchReport(id);
    } catch (err) {
      this.log.warn(
        `Update check failed quietly: ${err instanceof Error ? err.message : String(err)}`,
      );
      report = this.localOnly(id, true);
      // A timeout or rate limit is usually brief. Keeping "offline"
      // for the full six hours hid updates long after GitHub was back.
      ttl = FAILED_CACHE_MS;
    }
    this.cache = { at: now, ttl, report };
    return report;
  }

  private localOnly(id: UpdateIdentity, offline = false): UpdateReport {
    return {
      current: {
        version: id.version,
        gitSha: id.gitSha,
        composeRev: id.composeRev,
      },
      latest: null,
      channel: id.channel,
      releaseNotesUrl: null,
      composeOutdated: composeOutdated(id),
      installType: id.installType,
      updateAvailable: false,
      breaking: [],
      offline,
    };
  }

  private async fetchReport(id: UpdateIdentity): Promise<UpdateReport> {
    if (id.channel === 'edge') return this.fetchEdge(id);
    return this.fetchStable(id);
  }

  private async fetchStable(id: UpdateIdentity): Promise<UpdateReport> {
    const release = (await this.github(
      `https://api.github.com/repos/${REPO}/releases/latest`,
    )) as { tag_name?: string; html_url?: string; body?: string };
    const tag = release.tag_name ?? '';
    const available = tag ? stableUpdateAvailable(id.version, tag) : false;
    return {
      current: {
        version: id.version,
        gitSha: id.gitSha,
        composeRev: id.composeRev,
      },
      latest: { version: tag || null, gitSha: null },
      channel: id.channel,
      releaseNotesUrl: release.html_url ?? null,
      composeOutdated: composeOutdated(id),
      installType: id.installType,
      updateAvailable: available,
      breaking: breakingLines(release.body ?? ''),
      offline: false,
    };
  }

  private async fetchEdge(id: UpdateIdentity): Promise<UpdateReport> {
    const commit = (await this.github(
      `https://api.github.com/repos/${REPO}/commits/main`,
    )) as { sha?: string };
    const latestSha = commit.sha ?? null;
    let breaking: string[] = [];
    try {
      const changelog = await this.text(
        `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`,
      );
      breaking = breakingLines(unreleasedSection(changelog));
    } catch {
      breaking = [];
    }
    const available = edgeUpdateAvailable(id.gitSha, latestSha);
    return {
      current: {
        version: id.version,
        gitSha: id.gitSha,
        composeRev: id.composeRev,
      },
      latest: { version: null, gitSha: latestSha },
      channel: 'edge',
      releaseNotesUrl: `https://github.com/${REPO}/commits/main`,
      composeOutdated: composeOutdated(id),
      installType: id.installType,
      updateAvailable: available,
      breaking,
      offline: false,
    };
  }

  private async github(url: string): Promise<unknown> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gratis-gis',
      },
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }

  private async text(url: string): Promise<string> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'gratis-gis' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
}
