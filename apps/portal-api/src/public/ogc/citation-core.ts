// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ItemRow } from './records-core.js';

/**
 * Pure citation builders for public items (BibTeX / RIS /
 * Schema.org Dataset JSON-LD). No DOI minting: the portal URL and
 * item UUID are the durable identifiers. Kept free of Nest so unit
 * tests do not pull ESM @nestjs/common.
 */

export type CitationItemRow = ItemRow & {
  org?: { name: string } | null;
};

export type CitationFormat = 'bibtex' | 'ris' | 'jsonld';

export interface CitationParts {
  citeKey: string;
  title: string;
  author: string;
  year: string;
  issued: string;
  url: string;
  abstract: string;
  license: string | null;
  keywords: string[];
  itemType: string;
}

export function citationParts(
  row: CitationItemRow,
  base: string,
): CitationParts {
  const year = String(row.createdAt.getUTCFullYear());
  const author =
    (row.owner?.fullName && row.owner.fullName.trim()) ||
    row.owner?.username ||
    row.org?.name ||
    'GratisGIS';
  const slug = bibKeySlug(row.title) || 'item';
  return {
    citeKey: `${slug}${year}`,
    title: row.title,
    author,
    year,
    issued: row.createdAt.toISOString().slice(0, 10),
    url: `${base.replace(/\/+$/, '')}/items/${row.id}`,
    abstract: (row.description && row.description.trim()) || row.title,
    license: row.license,
    keywords: row.tags ?? [],
    itemType: row.type,
  };
}

export function buildBibTeX(row: CitationItemRow, base: string): string {
  const p = citationParts(row, base);
  const entryType = bibEntryType(p.itemType);
  const lines = [
    `@${entryType}{${p.citeKey},`,
    `  title = {${bibEscape(p.title)}},`,
    `  author = {${bibEscape(p.author)}},`,
    `  year = {${p.year}},`,
    `  url = {${p.url}},`,
    `  note = {GratisGIS item ${row.id}},`,
  ];
  if (p.abstract && p.abstract !== p.title) {
    lines.push(`  abstract = {${bibEscape(p.abstract)}},`);
  }
  if (p.license) {
    lines.push(`  copyright = {${bibEscape(p.license)}},`);
  }
  if (p.keywords.length > 0) {
    lines.push(`  keywords = {${bibEscape(p.keywords.join(', '))}},`);
  }
  // Drop trailing comma on the last field line for cleaner BibTeX.
  const last = lines[lines.length - 1]!;
  lines[lines.length - 1] = last.replace(/,$/, '');
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function buildRis(row: CitationItemRow, base: string): string {
  const p = citationParts(row, base);
  const ty = risType(p.itemType);
  const out: string[] = [
    `TY  - ${ty}`,
    `TI  - ${risEscape(p.title)}`,
    `AU  - ${risEscape(p.author)}`,
    `PY  - ${p.year}`,
    `DA  - ${p.issued}`,
    `UR  - ${p.url}`,
    `ID  - ${row.id}`,
  ];
  if (p.abstract) out.push(`AB  - ${risEscape(p.abstract)}`);
  if (p.license) out.push(`KW  - license:${risEscape(p.license)}`);
  for (const kw of p.keywords) {
    out.push(`KW  - ${risEscape(kw)}`);
  }
  out.push('ER  - ');
  return out.join('\n') + '\n';
}

export function buildJsonLd(
  row: CitationItemRow,
  base: string,
): Record<string, unknown> {
  const p = citationParts(row, base);
  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': jsonLdType(p.itemType),
    name: p.title,
    description: p.abstract,
    url: p.url,
    identifier: row.id,
    datePublished: p.issued,
    dateModified: row.updatedAt.toISOString().slice(0, 10),
    creator: {
      '@type': 'Person',
      name: p.author,
    },
  };
  if (row.org?.name) {
    doc.publisher = { '@type': 'Organization', name: row.org.name };
  }
  if (p.license) doc.license = p.license;
  if (p.keywords.length > 0) doc.keywords = p.keywords.join(', ');
  return doc;
}

export function mediaTypeFor(format: CitationFormat): string {
  switch (format) {
    case 'bibtex':
      return 'application/x-bibtex; charset=utf-8';
    case 'ris':
      return 'application/x-research-info-systems; charset=utf-8';
    case 'jsonld':
      return 'application/ld+json; charset=utf-8';
  }
}

export function filenameFor(
  row: CitationItemRow,
  format: CitationFormat,
): string {
  const slug = bibKeySlug(row.title) || 'item';
  switch (format) {
    case 'bibtex':
      return `${slug}.bib`;
    case 'ris':
      return `${slug}.ris`;
    case 'jsonld':
      return `${slug}.jsonld`;
  }
}

function bibEntryType(type: string): string {
  switch (type) {
    case 'data_layer':
    case 'derived_layer':
    case 'tile_layer':
    case 'point_cloud':
      return 'dataset';
    case 'map':
    case 'web_app':
    case 'dashboard':
      return 'misc';
    default:
      return 'misc';
  }
}

function risType(type: string): string {
  switch (type) {
    case 'data_layer':
    case 'derived_layer':
    case 'tile_layer':
    case 'point_cloud':
      return 'DATA';
    case 'map':
    case 'web_app':
    case 'dashboard':
      return 'MAP';
    default:
      return 'GEN';
  }
}

function jsonLdType(type: string): string {
  switch (type) {
    case 'data_layer':
    case 'derived_layer':
    case 'tile_layer':
    case 'point_cloud':
      return 'Dataset';
    case 'map':
    case 'web_app':
    case 'dashboard':
      return 'Map';
    default:
      return 'CreativeWork';
  }
}

function bibKeySlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 24);
}

function bibEscape(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/[#%&_]/g, (c) => `\\${c}`);
}

function risEscape(value: string): string {
  // RIS is line-oriented; collapse newlines so fields stay on one line.
  return value.replace(/[\r\n]+/g, ' ').trim();
}
