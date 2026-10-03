// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderMarkdown } from './markdown';

describe('renderMarkdown images and links', () => {
  it('renders a help figure as an image element', () => {
    const html = renderMarkdown(
      '![New item wizard](/help/new-item.svg)\n',
    );
    expect(html).toBe(
      '<p><img src="/help/new-item.svg" alt="New item wizard"></p>',
    );
  });

  it('renders a link without escaping the anchor', () => {
    const html = renderMarkdown('See [the map](/help/items/map).\n');
    expect(html).toBe(
      '<p>See <a href="/help/items/map">the map</a>.</p>',
    );
  });

  it('keeps bold inside a link and code beside an image', () => {
    const html = renderMarkdown(
      'Use [`lat`](/help/uploading-csv) or ![pin](/help/csv-upload.svg).\n',
    );
    expect(html).toContain('<a href="/help/uploading-csv"><code>lat</code></a>');
    expect(html).toContain('<img src="/help/csv-upload.svg" alt="pin">');
    expect(html).not.toContain('&lt;img');
  });

  it('drops a javascript URL', () => {
    const html = renderMarkdown('[click](javascript:alert(1))\n');
    expect(html).toContain('href="#"');
  });
});
