// SPDX-License-Identifier: AGPL-3.0-or-later
import { decideSignInOrigin } from './auth-origin';

describe('decideSignInOrigin', () => {
  const env = { NEXTAUTH_URL: 'http://192.168.15.82:8085' } as NodeJS.ProcessEnv;

  it('allows the configured LAN host', () => {
    expect(decideSignInOrigin('192.168.15.82:8085', env).allowed).toBe(true);
  });

  it('refuses a Tailscale hostname so login is not sent to the LAN address', () => {
    const decision = decideSignInOrigin('mynas.tail1234.ts.net', env);
    expect(decision.allowed).toBe(false);
    expect(decision.canonical).toBe('http://192.168.15.82:8085');
    expect(decision.openedHost).toBe('mynas.tail1234.ts.net');
    expect(decision.suggestedBaseUrl).toBe('https://mynas.tail1234.ts.net');
  });

  it('refuses the tailnet IP on the same port', () => {
    const decision = decideSignInOrigin('100.64.1.8:8085', env);
    expect(decision.allowed).toBe(false);
    expect(decision.suggestedBaseUrl).toBe('http://100.64.1.8:8085');
  });

  it('matches a MagicDNS host when that name is the configured URL', () => {
    const tailscale = {
      NEXTAUTH_URL: 'https://mynas.tail1234.ts.net',
    } as NodeJS.ProcessEnv;
    expect(decideSignInOrigin('mynas.tail1234.ts.net', tailscale).allowed).toBe(
      true,
    );
  });

  it('uses the first forwarded host', () => {
    expect(
      decideSignInOrigin('192.168.15.82:8085, evil.example', env).allowed,
    ).toBe(true);
  });
});
