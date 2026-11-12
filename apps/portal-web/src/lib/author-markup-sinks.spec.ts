// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Author-controlled values that reach innerHTML or a navigation call
 * outside the shared sanitizers. Each case here was a stored XSS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderIconSvg } from '@/app/items/[id]/map/map-icons';

describe('renderIconSvg', () => {
  it('drops a stroke that would leave the attribute', () => {
    const svg = renderIconSvg('circle', {
      stroke: '"/><iframe srcdoc="<script>alert(1)</script>"></iframe><svg x="',
    });
    expect(svg).not.toContain('iframe');
    expect(svg).toContain('stroke="currentColor"');
  });

  it('keeps a real color', () => {
    expect(renderIconSvg('circle', { stroke: '#6366f1' })).toContain(
      'stroke="#6366f1"',
    );
    expect(renderIconSvg('circle', { stroke: 'rgba(1, 2, 3, 0.5)' })).toContain(
      'stroke="rgba(1, 2, 3, 0.5)"',
    );
  });

  it('ignores a stroke width that is not a number', () => {
    const svg = renderIconSvg('circle', {
      strokeWidth: '2"><script>x</script>' as unknown as number,
    });
    expect(svg).toContain('stroke-width="2"');
    expect(svg).not.toContain('<script>');
  });
});

describe('tool open-url action', () => {
  it('navigates only through safeNavigationUrl', () => {
    const source = readFileSync(
      join(__dirname, '..', 'app', 'items', '[id]', 'custom', 'runtime-client.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/location\.assign\(\s*action\.url/);
    expect(source).not.toMatch(/window\.open\(\s*action\.url/);
    expect(source).toMatch(/safeNavigationUrl\(action\.url\)/);
  });
});

describe('notification template previews', () => {
  it('render admin HTML only inside a sandboxed frame', () => {
    const source = readFileSync(
      join(__dirname, '..', 'app', 'admin', 'notifications', 'notifications-admin-view.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).toMatch(/<iframe\s+sandbox=""\s+srcDoc=\{html\}/);
  });
});
