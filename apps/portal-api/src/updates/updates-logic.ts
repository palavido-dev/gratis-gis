// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure comparisons for the admin update check. No network, no clock.
 * The service wraps these with the GitHub fetch and the 6-hour cache.
 */

export type InstallType = 'nas' | 'vps' | 'dev';

export interface UpdateIdentity {
  version: string;
  gitSha: string | null;
  composeRev: string | null;
  requiredComposeRev: string | null;
  channel: string;
  installType: InstallType;
}

export interface UpdateLatest {
  version: string | null;
  gitSha: string | null;
  releaseNotesUrl: string | null;
  breaking: string[];
}

/** Leading vX.Y.Z from a release tag or a `git describe` string. */
export function parseSemver(input: string): [number, number, number] | null {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `latest` is a newer X.Y.Z than `current`. */
export function semverGreater(latest: string, current: string): boolean {
  const next = parseSemver(latest);
  const have = parseSemver(current);
  if (!next || !have) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== have[i]) return next[i]! > have[i]!;
  }
  return false;
}

/**
 * Short and full SHAs of the same commit compare equal. Two
 * different commits do not.
 */
export function shasDiffer(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const a = current.trim().toLowerCase();
  const b = latest.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return false;
  return true;
}

/** NAS only. A missing rev on either side is not "outdated". */
export function composeOutdated(identity: UpdateIdentity): boolean {
  if (identity.installType !== 'nas') return false;
  const have = identity.composeRev?.trim() ?? '';
  const need = identity.requiredComposeRev?.trim() ?? '';
  if (!have || !need) return false;
  return have !== need;
}

/** edge, latest, or a stable vX.Y.Z tag. Other pull tags stay on edge. */
export function channelFromImageTag(tag: string): string {
  const value = tag.trim() || 'edge';
  if (value === 'latest' || /^v\d+\.\d+\.\d+$/.test(value)) return value;
  return 'edge';
}

export function installTypeFromEnv(raw: string | undefined): InstallType {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'nas' || value === 'vps' || value === 'dev') return value;
  return 'dev';
}

/** Lines the changelog marks as breaking. See docs/UPGRADING.md. */
export function breakingLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Breaking:'));
}

/** The Unreleased section of CHANGELOG.md, used for the edge channel. */
export function unreleasedSection(changelog: string): string {
  const marker = '## [Unreleased]';
  const start = changelog.indexOf(marker);
  if (start < 0) return '';
  const rest = changelog.slice(start + marker.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

export function stableUpdateAvailable(currentVersion: string, latestTag: string): boolean {
  return semverGreater(latestTag, currentVersion);
}

export function edgeUpdateAvailable(
  currentSha: string | null,
  latestSha: string | null,
): boolean {
  return shasDiffer(currentSha, latestSha);
}
