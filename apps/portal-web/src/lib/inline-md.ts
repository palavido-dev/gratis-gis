// SPDX-License-Identifier: AGPL-3.0-or-later
// Inline markdown to HTML for the text widget's rich-text editor in
// the custom app designer. The editor paints this HTML into a
// contenteditable box and turns it back into markdown on blur, so a
// mistake here is saved on the author's next edit.
import { safeHttpHref } from '@gratis-gis/shared-types';

export function inlineMdToHtml(s: string): string {
  // Preserve color spans verbatim BEFORE the HTML escape pass so a
  // `<span style="color:#xxx">text</span>` written by the rich-text
  // editor's color picker survives the round-trip.  Each match is
  // stashed under a placeholder; we escape the rest, run markdown
  // transforms, then restore canonical spans.  Only the exact shape
  // (color style, no other attributes, no nested tags) survives --
  // arbitrary HTML never passes through.
  const colorSpans: string[] = [];
  const pre = s.replace(
    /<span style="color:\s*(#[0-9a-fA-F]{3,8})">([^<]+)<\/span>/g,
    (_m, color, text) => {
      const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const idx = colorSpans.length;
      colorSpans.push(`<span style="color: ${color}">${escaped}</span>`);
      return ` COLOR${idx} `;
    },
  );
  let out = pre
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Each href is stashed under a placeholder while the emphasis and
  // code passes run, then put back.  Those passes used to run over
  // the generated attribute too, so `*` or a backtick in a URL became
  // markup inside the href and the next blur saved a broken link.
  const hrefs: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const safeHref = safeHttpHref(String(href));
    if (!safeHref) return String(text);
    const idx = hrefs.length;
    hrefs.push(safeHref.replace(/"/g, '&quot;'));
    return `<a href="\uE000${idx}\uE000">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\uE000(\d+)\uE000/g, (_m, idx) => hrefs[Number(idx)] ?? '');
  out = out.replace(/ COLOR(\d+) /g, (_m, idx) => {
    return colorSpans[Number(idx)] ?? '';
  });
  return out;
}
