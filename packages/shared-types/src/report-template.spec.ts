// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultReportBody,
  markdownToHtml,
  parseReportBody,
  renderReportHtml,
} from './report-template';

describe('parseReportBody', () => {
  it('finds fields, expressions and photos', () => {
    const p = parseReportBody(
      "Hi {{name}}, total {{= coalesce({{a}}, 'x}}y') + 1 }} {{photos}} {{ not valid }}",
    );
    expect(p.placeholders).toEqual([
      { kind: 'field', name: 'name' },
      { kind: 'expression', source: "coalesce({{a}}, 'x}}y') + 1" },
      { kind: 'photos' },
    ]);
    expect(p.segments.filter((s) => 'text' in s).map((s) => (s as { text: string }).text)).toEqual([
      'Hi ',
      ', total ',
      ' ',
      ' {{ not valid }}',
    ]);
  });
});

describe('renderReportHtml', () => {
  it('escapes values and template text, and renders Markdown', () => {
    const p = parseReportBody(
      '# Site {{id}}\n\n**Status:** {{status}}\n\n<script>x</script>\n\n| A | B |\n|---|---|\n| {{status}} | *ok* |',
    );
    const html = renderReportHtml(p, [{ text: '7' }, { text: '<b>**open**</b>' }, { text: 'a|b' }]);
    expect(html).toContain('<h1>Site 7</h1>');
    expect(html).toContain('<strong>Status:</strong> &lt;b&gt;**open**&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<td>a|b</td><td><em>ok</em></td>');
    expect(html).not.toContain('<script>');
  });

  it('renders photos and drops a missing value', () => {
    const p = parseReportBody('{{photos}}{{gone}}');
    const html = renderReportHtml(p, [
      { images: [{ src: 'data:image/jpeg;base64,AA', caption: 'a"b' }] },
      null,
    ]);
    expect(html).toContain('<img src="data:image/jpeg;base64,AA" alt="a&quot;b">');
  });
});

describe('markdownToHtml', () => {
  it('handles lists, rules and page breaks', () => {
    expect(markdownToHtml('- a\n- b\n\n1. c\n---\n\\pagebreak')).toBe(
      '<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li></ol>\n<hr>\n<div class="page-break"></div>',
    );
  });
});

describe('defaultReportBody', () => {
  it('lists every field', () => {
    expect(defaultReportBody('Trees', [{ name: 'height', label: 'Height | ft' }])).toContain(
      '| Height / ft | {{height}} |',
    );
  });
});
