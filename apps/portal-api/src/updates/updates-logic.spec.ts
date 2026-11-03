// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  breakingLines,
  channelFromImageTag,
  composeOutdated,
  edgeUpdateAvailable,
  installTypeFromEnv,
  semverGreater,
  shasDiffer,
  stableUpdateAvailable,
  unreleasedSection,
  type UpdateIdentity,
} from './updates-logic.js';

function identity(patch: Partial<UpdateIdentity> = {}): UpdateIdentity {
  return {
    version: 'v1.1.0',
    gitSha: 'abcdef1234567890',
    composeRev: '1',
    requiredComposeRev: '1',
    channel: 'edge',
    installType: 'nas',
    ...patch,
  };
}

describe('update comparison', () => {
  it('compares semver and ignores a describe suffix', () => {
    expect(semverGreater('v1.2.0', 'v1.1.0')).toBe(true);
    expect(semverGreater('v1.1.0', 'v1.1.0')).toBe(false);
    expect(semverGreater('v1.1.0', 'v1.2.0')).toBe(false);
    expect(stableUpdateAvailable('v1.1.0-4-gabc1234', 'v1.2.0')).toBe(true);
    expect(stableUpdateAvailable('v1.2.0', 'v1.2.0')).toBe(false);
  });

  it('treats a short SHA and its full form as the same commit', () => {
    expect(shasDiffer('abcdef1234567890', 'abcdef12')).toBe(false);
    expect(shasDiffer('abcdef1234567890', 'ffffff1234567890')).toBe(true);
    expect(edgeUpdateAvailable('abcdef12', 'abcdef1234567890')).toBe(false);
    expect(edgeUpdateAvailable(null, 'abcdef12')).toBe(false);
    expect(edgeUpdateAvailable('aaaa', 'bbbb')).toBe(true);
  });

  it('flags an outdated NAS compose revision and ignores other installs', () => {
    expect(composeOutdated(identity({ composeRev: '1', requiredComposeRev: '2' }))).toBe(
      true,
    );
    expect(composeOutdated(identity())).toBe(false);
    expect(
      composeOutdated(
        identity({ installType: 'vps', composeRev: '1', requiredComposeRev: '2' }),
      ),
    ).toBe(false);
    expect(composeOutdated(identity({ composeRev: '', requiredComposeRev: '2' }))).toBe(
      false,
    );
  });

  it('maps the image tag onto a channel', () => {
    expect(channelFromImageTag('edge')).toBe('edge');
    expect(channelFromImageTag('latest')).toBe('latest');
    expect(channelFromImageTag('v1.2.3')).toBe('v1.2.3');
    expect(channelFromImageTag('sha-abcdef')).toBe('edge');
    expect(installTypeFromEnv('nas')).toBe('nas');
    expect(installTypeFromEnv(undefined)).toBe('dev');
  });

  it('reads Breaking lines from a release body and from Unreleased', () => {
    const body = 'hello\nBreaking: drop port 80\n- note\nBreaking: rename the volume\n';
    expect(breakingLines(body)).toEqual([
      'Breaking: drop port 80',
      'Breaking: rename the volume',
    ]);
    const changelog = '# Changelog\n\n## [Unreleased]\n\nBreaking: new compose rev\n\n## [1.1.0]\n\nBreaking: old\n';
    expect(breakingLines(unreleasedSection(changelog))).toEqual([
      'Breaking: new compose rev',
    ]);
  });
});
