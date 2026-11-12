// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sanitizer's attribute regex and comment / CDATA strips were
// quadratic: `<svg ` plus a long run of letters, or many unterminated
// `<!--`, held the API for minutes on a 1 MB upload. They are linear
// scans now; these cases pin both the behaviour and the speed.

import { sanitizeSvg } from './svg-sanitizer.js';

const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" fill=\'red\'/></svg>';

describe('sanitizeSvg', () => {
  it('keeps a plain icon and its attributes', () => {
    const out = sanitizeSvg(ok);
    expect(out).not.toBeNull();
    expect(out).toContain('d="M0 0L24 24"');
    expect(out).toContain('fill="red"');
  });

  it('drops comments and CDATA, and refuses an unterminated one', () => {
    expect(sanitizeSvg(ok.replace('<path', '<!-- c --><path'))).not.toBeNull();
    expect(sanitizeSvg(ok.replace('<path', '<!-- c <path'))).toBeNull();
    expect(sanitizeSvg(ok.replace('<path', '<![CDATA[ x <path'))).toBeNull();
  });

  it('refuses a malformed attribute list', () => {
    expect(sanitizeSvg(ok.replace('fill=', 'fill'))).toBeNull();
    expect(sanitizeSvg(ok.replace('<path', '<path !'))).toBeNull();
  });

  it('answers hostile 1 MB inputs quickly', () => {
    const big = 1_000_000;
    let t = Date.now();
    sanitizeSvg('<svg ' + 'a'.repeat(big) + '>');
    sanitizeSvg('<!--'.repeat(big / 4));
    sanitizeSvg('<svg viewBox="0 0 1 1">' + '<![CDATA['.repeat(big / 9) + '</svg>');
    expect(Date.now() - t).toBeLessThan(2000);
    t = Date.now();
    sanitizeSvg('<svg ' + 'a = "x" '.repeat(big / 8) + '>');
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('sanitizeSvg viewBox and external references', () => {
  it('keeps the uploaded viewBox instead of forcing 0 0 24 24', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/></svg>',
    );
    expect(out).toContain('viewBox="0 0 512 512"');
    expect(out).not.toContain('0 0 24 24');
  });

  it('still adds a default viewBox when there is none', () => {
    expect(sanitizeSvg('<svg><path d="M0 0"/></svg>')).toContain('viewBox="0 0 24 24"');
  });

  it('keeps a same-document paint reference', () => {
    expect(
      sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0" fill="url(#g)"/></svg>'),
    ).toContain('fill="url(#g)"');
  });

  it('refuses an external paint reference or a CSS escape', () => {
    expect(
      sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0" fill="url(https://host/x.svg#p)"/></svg>'),
    ).toBeNull();
    expect(
      sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0" style="fill:\\75rl(https://host/a)"/></svg>'),
    ).toBeNull();
  });
});
