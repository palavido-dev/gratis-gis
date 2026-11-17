// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A small Mapbox Vector Tile reader for specs.
 *
 * Specs that only need "is this id somewhere in the tile" search the
 * raw bytes. Specs that need to know WHICH layer a feature sits in,
 * what its properties are, or where a point is, need the structure,
 * and a dependency for a few dozen lines of protobuf walking is not
 * worth it. Covers exactly what ST_AsMVT emits: layers with name,
 * keys, values (string, float, double, int, uint, sint, bool) and
 * features with tags, type and geometry commands. Not for production
 * use: no bounds checks beyond what a well-formed tile needs.
 */

export interface DecodedFeature {
  type: number;
  properties: Record<string, string | number | boolean>;
  /** Geometry as rings / parts of tile-space [x, y] coordinates. */
  geometry: Array<Array<[number, number]>>;
}

export interface DecodedLayer {
  name: string;
  extent: number;
  features: DecodedFeature[];
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  string(): string {
    const r = this.sub();
    return Buffer.from(this.buf.subarray(r.pos, r.end)).toString('utf8');
  }
  packed(): number[] {
    const r = this.sub();
    const out: number[] = [];
    while (r.pos < r.end) out.push(r.varint());
    return out;
  }
}

const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(r: Reader): string | number | boolean {
  let v: string | number | boolean = '';
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) v = r.string();
    else if (field === 2) {
      v = Buffer.from(r.buf.subarray(r.pos, r.pos + 4)).readFloatLE(0);
      r.pos += 4;
    } else if (field === 3) {
      v = Buffer.from(r.buf.subarray(r.pos, r.pos + 8)).readDoubleLE(0);
      r.pos += 8;
    } else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = r.varint() === 1;
    else r.skip(wire);
  }
  return v;
}

function decodeGeometry(cmds: number[]): Array<Array<[number, number]>> {
  const parts: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++]!;
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) {
      if (cur && cur.length > 0) cur.push(cur[0]!);
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]!);
      y += zigzag(cmds[i++]!);
      if (id === 1) {
        cur = [];
        parts.push(cur);
      }
      cur!.push([x, y]);
    }
  }
  return parts;
}

/** Decode every layer of an MVT. An empty buffer is an empty tile. */
export function decodeMvt(bytes: Uint8Array): DecodedLayer[] {
  const top = new Reader(bytes);
  const layers: DecodedLayer[] = [];
  while (top.pos < top.end) {
    const tag = top.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      top.skip(tag & 7);
      continue;
    }
    const lr = top.sub();
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: Array<string | number | boolean> = [];
    const raw: Array<{ type: number; tags: number[]; geom: number[] }> = [];
    while (lr.pos < lr.end) {
      const t = lr.varint();
      const field = t >> 3;
      if (field === 1) name = lr.string();
      else if (field === 3) keys.push(lr.string());
      else if (field === 4) values.push(readValue(lr.sub()));
      else if (field === 5) extent = lr.varint();
      else if (field === 2) {
        const fr = lr.sub();
        const f = { type: 0, tags: [] as number[], geom: [] as number[] };
        while (fr.pos < fr.end) {
          const ft = fr.varint();
          const ff = ft >> 3;
          if (ff === 2) f.tags = fr.packed();
          else if (ff === 3) f.type = fr.varint();
          else if (ff === 4) f.geom = fr.packed();
          else fr.skip(ft & 7);
        }
        raw.push(f);
      } else lr.skip(t & 7);
    }
    layers.push({
      name,
      extent,
      features: raw.map((f) => {
        const properties: Record<string, string | number | boolean> = {};
        for (let i = 0; i + 1 < f.tags.length; i += 2) {
          properties[keys[f.tags[i]!]!] = values[f.tags[i + 1]!]!;
        }
        return { type: f.type, properties, geometry: decodeGeometry(f.geom) };
      }),
    });
  }
  return layers;
}
