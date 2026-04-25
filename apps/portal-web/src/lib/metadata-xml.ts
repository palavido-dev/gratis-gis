/**
 * Lightweight client-side parser for the three metadata XML formats
 * the GIS world stubbornly keeps in circulation:
 *
 *   - ISO 19115 / 19139      (root: gmd:MD_Metadata)
 *   - FGDC CSDGM             (root: metadata)
 *   - Dublin Core / DCAT     (root: rdf:RDF or oai_dc:dc)
 *
 * The output is a normalised, optional bag of fields that the
 * new-item wizard (and eventually the item-edit form) can pre-fill
 * from. Anything not present in the source XML is left absent so
 * the caller's existing form state stays the source of truth.
 *
 * Browser-only: relies on `DOMParser` and the global `XMLSerializer`,
 * which keep this off the API's plate. The 80-90% of operator-
 * supplied metadata files are small (a few KB) and never see the
 * network.
 */
export interface ParsedMetadata {
  title?: string;
  description?: string;
  tags?: string[];
  license?: string;
  /** [west, south, east, north] in EPSG:4326. */
  bbox?: [number, number, number, number];
  /** What format we detected; lets the caller surface a small note. */
  source: 'iso19115' | 'fgdc' | 'dublin-core' | 'unknown';
}

/**
 * Parse a string of XML and return whatever metadata fields we can
 * extract. Throws when the XML is structurally invalid; returns
 * `{ source: 'unknown' }` when the XML is well-formed but doesn't
 * match any of our recognised schemas.
 */
export function parseMetadataXml(text: string): ParsedMetadata {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // DOMParser does not throw on malformed input; instead it returns a
  // document whose root is `<parsererror>`. Surface that as a real
  // error so the caller can show a useful message.
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw new Error(parserError.textContent ?? 'Could not parse XML.');
  }
  const root = doc.documentElement;
  if (!root) return { source: 'unknown' };

  const localName = root.localName.toLowerCase();

  if (localName === 'md_metadata') return parseIso(doc);
  if (localName === 'metadata') return parseFgdc(doc);
  if (localName === 'rdf' || localName === 'dc' || localName === 'oai_dc:dc') {
    return parseDublinCore(doc);
  }
  // Heuristic fallback: look for the namespaces we know.
  const xml = root.outerHTML;
  if (xml.includes('http://www.isotc211.org/2005/gmd')) return parseIso(doc);
  if (xml.includes('http://purl.org/dc/elements/1.1/')) {
    return parseDublinCore(doc);
  }
  return { source: 'unknown' };
}

// ---------------------------------------------------------------
// ISO 19115 / 19139
// ---------------------------------------------------------------

function parseIso(doc: Document): ParsedMetadata {
  const out: ParsedMetadata = { source: 'iso19115' };

  const title = textByLocal(
    doc,
    'identificationInfo',
    'citation',
    'title',
  );
  if (title) out.title = title;

  const abstract = textByLocal(doc, 'identificationInfo', 'abstract');
  if (abstract) out.description = abstract;

  // Keywords: walk every gmd:keyword and pull the inner CharacterString.
  const keywords: string[] = [];
  const kwNodes = elementsByLocal(doc, 'keyword');
  for (const k of kwNodes) {
    const t = (k.textContent ?? '').trim();
    if (t) keywords.push(t);
  }
  if (keywords.length > 0) out.tags = unique(keywords);

  // License: gmd:resourceConstraints > gmd:MD_LegalConstraints >
  // gmd:useLimitation. Take the first non-empty.
  const limit = textByLocal(doc, 'resourceConstraints', 'useLimitation');
  if (limit) out.license = limit;

  // Bounding box: gmd:EX_GeographicBoundingBox.
  const bbox = parseBboxIso(doc);
  if (bbox) out.bbox = bbox;

  return out;
}

function parseBboxIso(
  doc: Document,
): [number, number, number, number] | undefined {
  const root = elementsByLocal(doc, 'EX_GeographicBoundingBox')[0];
  if (!root) return undefined;
  const w = parseFloat(localText(root, 'westBoundLongitude'));
  const e = parseFloat(localText(root, 'eastBoundLongitude'));
  const s = parseFloat(localText(root, 'southBoundLatitude'));
  const n = parseFloat(localText(root, 'northBoundLatitude'));
  if ([w, e, s, n].some((v) => !Number.isFinite(v))) return undefined;
  return [w, s, e, n];
}

// ---------------------------------------------------------------
// FGDC CSDGM
// ---------------------------------------------------------------

function parseFgdc(doc: Document): ParsedMetadata {
  const out: ParsedMetadata = { source: 'fgdc' };

  const title = localText(doc.documentElement, 'title');
  if (title) out.title = title;
  const abstract = localText(doc.documentElement, 'abstract');
  if (abstract) out.description = abstract;

  // FGDC keywords are spread across <theme>, <place>, and friends.
  // Each block has <themekt>/<themekey> pairs; we want every key.
  const keywords: string[] = [];
  for (const tag of ['themekey', 'placekey', 'stratkey', 'tempkey']) {
    for (const el of elementsByLocal(doc, tag)) {
      const t = (el.textContent ?? '').trim();
      if (t) keywords.push(t);
    }
  }
  if (keywords.length > 0) out.tags = unique(keywords);

  // FGDC <useconst> is the closest analogue to a license string.
  const useconst = localText(doc.documentElement, 'useconst');
  if (useconst) out.license = useconst;

  // Bounding box: <bounding> with <westbc> etc.
  const bnd = elementsByLocal(doc, 'bounding')[0];
  if (bnd) {
    const w = parseFloat(localText(bnd, 'westbc'));
    const e = parseFloat(localText(bnd, 'eastbc'));
    const s = parseFloat(localText(bnd, 'southbc'));
    const n = parseFloat(localText(bnd, 'northbc'));
    if ([w, e, s, n].every((v) => Number.isFinite(v))) {
      out.bbox = [w, s, e, n];
    }
  }

  return out;
}

// ---------------------------------------------------------------
// Dublin Core (and DCAT-style RDF wrapping it)
// ---------------------------------------------------------------

function parseDublinCore(doc: Document): ParsedMetadata {
  const out: ParsedMetadata = { source: 'dublin-core' };
  const title = dcText(doc, 'title');
  if (title) out.title = title;
  const desc = dcText(doc, 'description');
  if (desc) out.description = desc;
  const subjects: string[] = [];
  for (const el of elementsByLocal(doc, 'subject')) {
    const t = (el.textContent ?? '').trim();
    if (t) subjects.push(t);
  }
  if (subjects.length > 0) out.tags = unique(subjects);
  const rights = dcText(doc, 'rights');
  if (rights) out.license = rights;
  return out;
}

function dcText(doc: Document, local: string): string | undefined {
  // Dublin Core elements live under either dc: or rdf:Description >
  // dc:; the by-localName helper handles both because it ignores
  // namespace prefixes.
  return localText(doc.documentElement, local);
}

// ---------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------

/** Walk `path` of tag local-names and return the inner text of the
 *  first leaf match. Each path step matches the first descendant
 *  with that local name, regardless of namespace prefix. */
function textByLocal(root: Document | Element, ...path: string[]): string {
  let cur: Document | Element | null =
    'documentElement' in root ? root.documentElement : root;
  for (const step of path) {
    if (!cur) return '';
    cur = elementsByLocal(cur, step)[0] ?? null;
  }
  if (!cur) return '';
  return (cur.textContent ?? '').trim();
}

/** Find the first descendant element with the given local name and
 *  return its trimmed text. */
function localText(scope: Document | Element, local: string): string {
  const el = elementsByLocal(scope, local)[0];
  return el ? (el.textContent ?? '').trim() : '';
}

/** Every descendant element whose local name matches `local`,
 *  ignoring namespace prefixes (`getElementsByTagNameNS('*', local)`
 *  is the right primitive but its support varies, so we filter
 *  in JS). */
function elementsByLocal(scope: Document | Element, local: string): Element[] {
  const all = scope.getElementsByTagName('*');
  const out: Element[] = [];
  const want = local.toLowerCase();
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (!el) continue;
    if (el.localName.toLowerCase() === want) out.push(el);
  }
  return out;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
