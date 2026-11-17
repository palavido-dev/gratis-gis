// SPDX-License-Identifier: AGPL-3.0-or-later
import { APP_RUNTIME_PATH_RE, appRuntimeCsp } from './app-runtime-csp';

const PAGE = "default-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:";

describe('appRuntimeCsp', () => {
  it('adds allowed origins to frame-src only', () => {
    expect(appRuntimeCsp(PAGE, ['https://dash.example.org', 'https://*.arcgis.com'])).toBe(
      "default-src 'self'; frame-src 'self' blob: https://dash.example.org https://*.arcgis.com; worker-src 'self' blob:",
    );
  });

  it('drops anything that is not a bare origin', () => {
    expect(
      appRuntimeCsp(PAGE, ["https://a.org; script-src 'unsafe-inline'", '*', 'https://ok.org']),
    ).toBe("default-src 'self'; frame-src 'self' blob: https://ok.org; worker-src 'self' blob:");
  });

  it('keeps the page policy when the list is empty', () => {
    expect(appRuntimeCsp(PAGE, [])).toBe(PAGE);
  });
});

describe('APP_RUNTIME_PATH_RE', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('matches the custom app runtime only', () => {
    expect(APP_RUNTIME_PATH_RE.test(`/items/${id}/custom/run`)).toBe(true);
    expect(APP_RUNTIME_PATH_RE.test(`/items/${id}/custom/run/`)).toBe(true);
    expect(APP_RUNTIME_PATH_RE.test(`/items/${id}/custom`)).toBe(false);
    expect(APP_RUNTIME_PATH_RE.test(`/items/${id}/viewer/run`)).toBe(false);
  });
});
