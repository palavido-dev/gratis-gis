// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  announceRecoveryFailure,
  parseRecoveryStatus,
  recoveryBanner,
  shouldAnnounceRecovery,
  type RecoveryStatus,
} from './recovery-status.js';

const failed: RecoveryStatus = {
  outcome: 'failed',
  phase: 'partial',
  kind: 'restore',
  portalDownload: false,
  offsiteVerified: false,
  immutable: false,
  detail: 'portal database was not restored',
};

describe('recovery status', () => {
  it('rejects a status that is not the expected shape', () => {
    expect(parseRecoveryStatus('not-json')).toBeNull();
    expect(parseRecoveryStatus('{"outcome":"failed","phase":"../x","detail":"n"}')).toBeNull();
    expect(
      parseRecoveryStatus(
        JSON.stringify({ outcome: 'failed', phase: 'partial', detail: failed.detail }),
      )?.outcome,
    ).toBe('failed');
  });

  it('banners only a failed recovery', () => {
    expect(recoveryBanner(failed)).toMatch(/did not finish/);
    expect(recoveryBanner({ ...failed, outcome: 'succeeded' })).toBeNull();
    expect(recoveryBanner(null)).toBeNull();
  });

  it('announces a failed phase once and never announces success', () => {
    const seen = new Set<string>();
    expect(shouldAnnounceRecovery(seen, failed, 'ops@example.test')).toBe(true);
    expect(shouldAnnounceRecovery(seen, failed, 'ops@example.test')).toBe(false);
    expect(shouldAnnounceRecovery(seen, { ...failed, outcome: 'succeeded' }, 'ops@example.test')).toBe(false);
    expect(shouldAnnounceRecovery(new Set(), failed, '')).toBe(false);
  });

  it('sends one mail through the sink and does not include a secret', async () => {
    const sent: Array<{ subject: string; text: string }> = [];
    const secret = 'drill-credential-ok';
    await announceRecoveryFailure(
      {
        async send(opts) {
          sent.push({ subject: opts.subject, text: opts.text });
        },
      },
      'ops@example.test',
      { ...failed, detail: `phase only, not ${secret}` },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('GratisGIS host recovery failed');
    expect(sent[0].text).toContain('partial');
    expect(sent[0].text).not.toContain(secret);
    await announceRecoveryFailure(
      {
        async send() {
          throw new Error('success must not send');
        },
      },
      'ops@example.test',
      { ...failed, outcome: 'succeeded' },
    );
  });
});
