// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatDateTime, formatNumber } from './i18n/format';
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';

/**
 * Render a `{{field}}` / `{{field | formatter:arg}}` label template.
 *
 * One renderer for the template editor's preview and the map search's
 * result labels. They had their own grammars: the editor offered and
 * previewed `| currency:USD` and `| date:short`, and search, which
 * knew no `:arg`, showed the raw `{{price | currency:USD}}` text.
 *
 * `escape` HTML-escapes each substituted value. Only an HTML preview
 * wants that; a label rendered as plain text would otherwise show
 * "Smith &amp; Sons".
 */
export function renderLabelTemplate(
  template: string,
  props: Record<string, unknown>,
  opts: { locale?: SupportedLocale; escape?: boolean } = {},
): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)\s*(?::([^}]*))?)?\}\}/g,
    (_, key: string, formatter?: string, rawArg?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const str = String(raw);
      const fmt = formatter?.toLowerCase();
      const arg = rawArg?.trim();
      let out = str;
      if (fmt === 'upper') out = str.toUpperCase();
      else if (fmt === 'lower') out = str.toLowerCase();
      else if (fmt === 'number') {
        const n = Number(str);
        if (!Number.isNaN(n)) out = formatNumber(n, locale);
      } else if (fmt === 'currency') {
        const n = Number(str);
        if (!Number.isNaN(n)) {
          try {
            out = formatNumber(n, locale, {
              style: 'currency',
              currency: arg || 'USD',
            });
          } catch {
            out = formatNumber(n, locale);
          }
        }
      } else if (fmt === 'date') {
        const d = new Date(str);
        if (!Number.isNaN(d.getTime())) {
          const style = (arg as 'short' | 'medium' | 'long' | 'full' | undefined) || 'medium';
          try {
            out = new Intl.DateTimeFormat(locale, { dateStyle: style }).format(d);
          } catch {
            out = formatDateTime(d, locale);
          }
        }
      }
      return opts.escape ? escapeHtml(out) : out;
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
