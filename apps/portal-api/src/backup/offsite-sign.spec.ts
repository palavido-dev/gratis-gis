// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import {
  generateOffsiteKeyPair,
  openKeyFile,
  sealKeyFile,
  sealStream,
  type OffsitePrivateKey,
} from './offsite-crypto.js';
import {
  newestGood,
  selectExpired,
  type ArtifactTrust,
  type OffsiteArtifact,
} from './offsite-rules.js';
import {
  ARCHIVE_FIELDS,
  artifactTrust,
  checkSignature,
  generateSigningKey,
  manifestBytes,
  parseManifest,
  parseVerifyKey,
  signingKeyFromSeed,
  signManifest,
  type ArchiveManifest,
} from './offsite-sign.js';

const KEY_MJS = path.resolve(__dirname, '../../../../infra/recovery/offsite-key.mjs');
const PASS = 'a key file passphrase, long enough';
const NAME = 'backup-2026-11-24T02-00-00-000-abcdef12.tar.gz';
const INSTALL = '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f0';
const PREFIX = 'gratisgis-0f1e2d3c/';
const DAY = 86_400_000;

const archive = (over: Partial<ArchiveManifest> = {}): ArchiveManifest => ({
  kind: 'archive',
  format: 'GROF1',
  install: INSTALL,
  prefix: PREFIX,
  name: `archives/${NAME}.enc`,
  bytes: '254',
  sha256: 'ab'.repeat(32),
  key: '8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184',
  created: '2026-11-24T02:00:00.000Z',
  ...over,
});

const EXPECT_ARCHIVE = {
  prefix: PREFIX,
  name: `archives/${NAME}.enc`,
  bytes: 254,
  installIds: [INSTALL],
};

describe('verify keys', () => {
  it('match the published test vector (seed of 32 bytes of 0x07)', () => {
    const k = signingKeyFromSeed(Buffer.alloc(32, 7));
    expect(k.verifyKey.text).toBe('ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX');
    expect(k.verifyKey.fingerprintText).toBe('058d-7940-89ab-a15b-eb25-76ac-2168-1b43');
    expect(
      parseVerifyKey(` ${k.verifyKey.text.slice(0, 20)}\n${k.verifyKey.text.slice(20)} `).text,
    ).toBe(k.verifyKey.text);
  });

  it('refuse a typo, the wrong length or another kind of key, without echoing it', () => {
    const t = generateSigningKey().verifyKey.text;
    const typo = `${t.slice(0, 20)}${t[20] === 'A' ? 'B' : 'A'}${t.slice(21)}`;
    expect(() => parseVerifyKey(typo)).toThrow(/checksum/);
    expect(() => parseVerifyKey(t.slice(0, -1))).toThrow(/wrong length/);
    const pub = generateOffsiteKeyPair().publicKey.text;
    expect(() => parseVerifyKey(pub)).toThrow(/starts with ggver1:/);
    try {
      parseVerifyKey(typo);
    } catch (e) {
      expect((e as Error).message).not.toContain(typo);
    }
  });
});

describe('signed manifests', () => {
  it('have stable canonical bytes (test vector)', () => {
    const bytes = manifestBytes(archive());
    expect(bytes.toString('utf8')).toBe(
      'gratisgis-offsite-signed-v1\n' +
        'kind=archive\n' +
        'format=GROF1\n' +
        `install=${INSTALL}\n` +
        `prefix=${PREFIX}\n` +
        `name=archives/${NAME}.enc\n` +
        'bytes=254\n' +
        `sha256=${'ab'.repeat(32)}\n` +
        'key=8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184\n' +
        'created=2026-11-24T02:00:00.000Z\n',
    );
    expect(bytes.length).toBe(350);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '400691dacd7403981b1b42c00c80bfaeb63c31a8478ebd0bd247d71ae462b17c',
    );
    // Ed25519 is deterministic: same key and bytes, same signature.
    const sig = signManifest(archive(), signingKeyFromSeed(Buffer.alloc(32, 7)));
    expect(sig.value).toBe(
      'f_gviI8Mdohf0m-2-Urp_UsRKJrbpOlgok_WrMQyUJKZcpTOX6GJxj7CndoU_h3shqctW4u8DMlQ7LzwIC4ACg',
    );
    expect(sig.verifyKey).toBe('058d-7940-89ab-a15b-eb25-76ac-2168-1b43');
  });

  it('do not depend on the order the fields were given in', () => {
    const m = archive();
    const reversed = Object.fromEntries(Object.entries(m).reverse()) as ArchiveManifest;
    expect(manifestBytes(reversed).equals(manifestBytes(m))).toBe(true);
  });

  it('parse back only from exactly canonical bytes', () => {
    const text = manifestBytes(archive()).toString('utf8');
    expect(parseManifest(text)).toEqual(archive());
    for (const bad of [
      text.slice(0, -1),
      `${text}\n`,
      text.replace('\n', '\r\n'),
      text.replace('kind=archive\nformat=GROF1', 'format=GROF1\nkind=archive'),
      text.replace('kind=archive', 'kind=other'),
      text.replace('format=GROF1', 'format=GROF2'),
      text.replace('bytes=254', 'bytes=0254'),
      text.replace(
        'created=2026-11-24T02:00:00.000Z\n',
        'created=2026-11-24T02:00:00.000Z\nextra=1\n',
      ),
      text.replace(`prefix=${PREFIX}`, 'prefix=../x/'),
      text.replace('created=2026-11-24T02:00:00.000Z', 'created=2026-11-24T02:00:00Z'),
      text.replace(SIGNED_LINE, 'gratisgis-offsite-signed-v2'),
    ]) {
      expect(parseManifest(bad)).toBeNull();
    }
  });

  it('refuse values outside their rules when made', () => {
    expect(() => manifestBytes(archive({ name: 'archives/a b.enc' }))).toThrow(/name/);
    expect(() => manifestBytes(archive({ bytes: '-1' }))).toThrow(/bytes/);
    expect(() => manifestBytes(archive({ prefix: 'no-slash' }))).toThrow(/prefix/);
    expect(() => manifestBytes(archive({ install: 'not-a-uuid' }))).toThrow(/install/);
    expect(() => manifestBytes({ ...archive(), extra: 'x' } as never)).toThrow(/wrong fields/);
  });
});

const SIGNED_LINE = 'gratisgis-offsite-signed-v1';

describe('checking a signature', () => {
  const signer = generateSigningKey();
  const trusted = [signer.verifyKey];
  const sidecar = (m = archive(), by = signer) => ({
    installId: INSTALL,
    signature: signManifest(m, by),
  });

  it('round trips: a signed sidecar verifies and gives back its manifest', () => {
    const r = checkSignature(sidecar(), trusted, EXPECT_ARCHIVE);
    expect(r).toMatchObject({ trust: 'verified', signer: signer.verifyKey.fingerprintText });
    expect(r.manifest).toEqual(archive());
  });

  it('survives a round trip through JSON, as it does through the bucket', () => {
    const j = JSON.parse(JSON.stringify(sidecar())) as unknown;
    expect(checkSignature(j, trusted, EXPECT_ARCHIVE).trust).toBe('verified');
  });

  it.each(ARCHIVE_FIELDS.filter((f) => f !== 'kind'))(
    'a changed signed field (%s) no longer verifies',
    (field) => {
      const j = sidecar();
      const lines = j.signature.manifest.split('\n');
      const i = lines.findIndex((l) => l.startsWith(`${field}=`));
      const value = lines[i]!.slice(field.length + 1);
      const replacement: Record<string, string> = {
        format: 'GROF1',
        install: '1f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f0',
        prefix: 'other/',
        name: 'archives/backup-2026-11-25T02-00-00-000-abcdef12.tar.gz.enc',
        bytes: '255',
        sha256: 'cd'.repeat(32),
        key: '0000-27c4-5ca4-dba4-eef7-c151-2d36-d184',
        created: '2027-11-24T02:00:00.000Z',
      };
      if (field === 'format') {
        // The only valid format value: change the header instead.
        lines[0] = 'gratisgis-offsite-signed-v9';
      } else {
        lines[i] = `${field}=${replacement[field] ?? value}`;
      }
      j.signature.manifest = lines.join('\n');
      expect(checkSignature(j, trusted, EXPECT_ARCHIVE).trust).toBe('bad');
    },
  );

  it('a changed signature value does not verify', () => {
    const j = sidecar();
    const sig = Buffer.from(j.signature.value, 'base64url');
    sig[10]! ^= 1;
    j.signature.value = sig.toString('base64url');
    expect(checkSignature(j, trusted, EXPECT_ARCHIVE)).toMatchObject({
      trust: 'bad',
      reason: 'The signature does not verify.',
    });
  });

  it('a signature for another copy, folder or size is refused, even though it verifies', () => {
    expect(
      checkSignature(sidecar(), trusted, { ...EXPECT_ARCHIVE, name: 'archives/other.enc' }).reason,
    ).toMatch(/name does not match/);
    expect(
      checkSignature(sidecar(), trusted, { ...EXPECT_ARCHIVE, prefix: 'elsewhere/' }).reason,
    ).toMatch(/folder does not match/);
    expect(checkSignature(sidecar(), trusted, { ...EXPECT_ARCHIVE, bytes: 253 }).reason).toMatch(
      /size does not match/,
    );
  });

  it('tells unsigned, untrusted, foreign and damaged apart', () => {
    expect(checkSignature({ installId: INSTALL }, trusted, EXPECT_ARCHIVE).trust).toBe('unsigned');
    expect(
      checkSignature(sidecar(archive(), generateSigningKey()), trusted, EXPECT_ARCHIVE).trust,
    ).toBe('untrusted');
    expect(checkSignature(sidecar(), [], EXPECT_ARCHIVE).trust).toBe('untrusted');
    expect(
      checkSignature(sidecar(), trusted, {
        ...EXPECT_ARCHIVE,
        installIds: ['aaaaaaaa-0000-4000-8000-000000000000'],
      }).trust,
    ).toBe('foreign');
    expect(checkSignature({ signature: { version: 2 } }, trusted, EXPECT_ARCHIVE).trust).toBe(
      'bad',
    );
    expect(checkSignature({ signature: 'x' }, trusted, EXPECT_ARCHIVE).trust).toBe('bad');
    expect(checkSignature(null, trusted, EXPECT_ARCHIVE).trust).toBe('unsigned');
  });

  it('a signer named with a trusted fingerprint but signed by another key is refused', () => {
    const j = sidecar(archive(), generateSigningKey());
    j.signature.verifyKey = signer.verifyKey.fingerprintText;
    expect(checkSignature(j, trusted, EXPECT_ARCHIVE).trust).toBe('bad');
  });
});

describe('selection with signatures', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const art = (id: string, ageDays: number, trust: ArtifactTrust): OffsiteArtifact => ({
    id,
    createdAt: new Date(now.getTime() - ageDays * DAY),
    complete: true,
    trust,
  });

  it('prefers the newest verified copy over newer legacy, unsigned or bad ones', () => {
    const list = [
      art('legacy', 1, 'legacy'),
      art('stranger', 2, 'unsigned'),
      art('bad', 0, 'bad'),
      art('signed', 5, 'verified'),
    ];
    expect(newestGood(list, now)!.id).toBe('signed');
  });

  it('counts legacy copies only until a signed one exists', () => {
    const before = [art('legacy-new', 40, 'legacy'), art('legacy-old', 50, 'legacy')];
    expect(selectExpired(before, now, 30)).toEqual(['legacy-old']);
    const after = [...before, art('signed', 45, 'verified')];
    expect(selectExpired(after, now, 30).sort()).toEqual(['legacy-new', 'legacy-old']);
  });

  it('never deletes a badly signed copy and never counts an unsigned stranger as newest', () => {
    const list = [
      art('bad', 90, 'bad'),
      art('stranger', 35, 'unsigned'),
      art('signed', 40, 'verified'),
    ];
    expect(selectExpired(list, now, 30).sort()).toEqual(['stranger']);
    expect(newestGood([art('stranger', 1, 'unsigned')], now)).toBeNull();
  });

  it('a sidecar without a signature counts as legacy only for this portal', () => {
    const unsigned = { trust: 'unsigned' as const, manifest: null, signer: null, reason: null };
    expect(artifactTrust(unsigned, { installId: INSTALL }, INSTALL)).toBe('legacy');
    expect(artifactTrust(unsigned, { installId: 'other' }, INSTALL)).toBe('unsigned');
    expect(artifactTrust({ ...unsigned, trust: 'untrusted' }, {}, INSTALL)).toBe('bad');
    expect(artifactTrust({ ...unsigned, trust: 'foreign' }, {}, INSTALL)).toBe('bad');
  });
});

describe('interop with infra/recovery/offsite-key.mjs', () => {
  let dir: string;
  let key: OffsitePrivateKey;
  const signer = generateSigningKey();
  const node = (args: string[]) =>
    spawnSync(process.execPath, [KEY_MJS, ...args], {
      env: { PATH: process.env.PATH ?? '', GG_OFFSITE_KEY_TEST_LOGN: '14' },
    });
  const passFile = () => path.join(dir, 'pass');
  const withPass = (...a: string[]) => [...a, '--passphrase-file', passFile()];

  /** A real encrypted copy and its signed sidecar, as the portal writes them. */
  async function makeCopy(plain: Buffer, by = signer) {
    const chunks: Buffer[] = [];
    for await (const c of sealStream(Readable.from([plain]), key.publicKey)) chunks.push(c);
    const sealed = Buffer.concat(chunks);
    const enc = path.join(dir, `${NAME}.enc`);
    fs.writeFileSync(enc, sealed);
    const side = {
      format: 'GROF1',
      kind: 'archive',
      installId: INSTALL,
      signature: signManifest(
        archive({
          bytes: String(sealed.length),
          sha256: createHash('sha256').update(sealed).digest('hex'),
          key: key.publicKey.fingerprintText,
        }),
        by,
      ),
    };
    fs.writeFileSync(`${enc}.json`, JSON.stringify(side, null, 2));
    return { enc, side: `${enc}.json` };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-osign-'));
    fs.writeFileSync(passFile(), `${PASS}\n`);
    key = generateOffsiteKeyPair();
    fs.writeFileSync(path.join(dir, 'k.ggkey'), await sealKeyFile(key, PASS, { logN: 14 }));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trust adds a verify key to a new file, sealed with the same passphrase, which the API reads', async () => {
    const r = node(
      withPass(
        'trust',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'k2.ggkey'),
        signer.verifyKey.text,
      ),
    );
    expect(r.stderr.toString()).toMatch(/Wrote/);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain(`Added verify key ${signer.verifyKey.fingerprintText}`);
    expect(fs.statSync(path.join(dir, 'k2.ggkey')).mode & 0o777).toBe(0o600);
    const opened = await openKeyFile(fs.readFileSync(path.join(dir, 'k2.ggkey')), PASS);
    expect(opened.publicKey.text).toBe(key.publicKey.text);
    expect(opened.verifyKeys.map((v) => v.text)).toEqual([signer.verifyKey.text]);
    // The original file is unchanged.
    expect(
      (await openKeyFile(fs.readFileSync(path.join(dir, 'k.ggkey')), PASS)).verifyKeys,
    ).toEqual([]);
  });

  it('trust keeps the verify keys already there, and does not add one twice', async () => {
    const older = generateSigningKey();
    fs.writeFileSync(
      path.join(dir, 'k.ggkey'),
      await sealKeyFile(key, PASS, { logN: 14, verifyKeys: [older.verifyKey.text] }),
    );
    const r = node(
      withPass(
        'trust',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'k2.ggkey'),
        signer.verifyKey.text,
        older.verifyKey.text,
      ),
    );
    expect(r.status).toBe(0);
    const opened = await openKeyFile(fs.readFileSync(path.join(dir, 'k2.ggkey')), PASS);
    expect(opened.verifyKeys.map((v) => v.text)).toEqual([
      older.verifyKey.text,
      signer.verifyKey.text,
    ]);
  });

  it('trust refuses to overwrite a file, a wrong passphrase, and a bad verify key', () => {
    fs.writeFileSync(path.join(dir, 'taken.ggkey'), 'keep me');
    let r = node(
      withPass(
        'trust',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'taken.ggkey'),
        signer.verifyKey.text,
      ),
    );
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(dir, 'taken.ggkey'), 'utf8')).toBe('keep me');
    // Over the old key file itself, too.
    r = node(
      withPass(
        'trust',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'k.ggkey'),
        signer.verifyKey.text,
      ),
    );
    expect(r.status).toBe(1);
    fs.writeFileSync(passFile(), 'the wrong passphrase, long enough\n');
    r = node(
      withPass(
        'trust',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'k3.ggkey'),
        signer.verifyKey.text,
      ),
    );
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/did not open/);
    expect(fs.existsSync(path.join(dir, 'k3.ggkey'))).toBe(false);
    r = node(
      withPass('trust', path.join(dir, 'k.ggkey'), path.join(dir, 'k4.ggkey'), 'ggver1:short'),
    );
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(dir, 'k4.ggkey'))).toBe(false);
  });

  it('a copy the API signed verifies with the script, and decrypt checks it first', async () => {
    fs.writeFileSync(
      path.join(dir, 'k.ggkey'),
      await sealKeyFile(key, PASS, { logN: 14, verifyKeys: [signer.verifyKey.text] }),
    );
    const plain = randomBytes(5000);
    const { enc, side } = await makeCopy(plain);
    let r = node(withPass('verify', path.join(dir, 'k.ggkey'), side, enc));
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain(
      `Verified: signed by the verify key ${signer.verifyKey.fingerprintText}`,
    );
    expect(r.stdout.toString()).toContain(`Portal:   install ${INSTALL}`);
    r = node(
      withPass('decrypt', path.join(dir, 'k.ggkey'), enc, path.join(dir, 'out'), '--sidecar', side),
    );
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out')).equals(plain)).toBe(true);
  });

  it('the script refuses a changed copy, an untrusted signer, a renamed copy and an unsigned one', async () => {
    fs.writeFileSync(
      path.join(dir, 'k.ggkey'),
      await sealKeyFile(key, PASS, { logN: 14, verifyKeys: [signer.verifyKey.text] }),
    );
    const { enc, side } = await makeCopy(randomBytes(3000));
    const kf = path.join(dir, 'k.ggkey');
    // A changed byte: decrypt writes nothing.
    const bytes = fs.readFileSync(enc);
    bytes[500]! ^= 1;
    fs.writeFileSync(path.join(dir, 'changed'), bytes);
    fs.copyFileSync(path.join(dir, 'changed'), enc);
    let r = node(withPass('decrypt', kf, enc, path.join(dir, 'out'), '--sidecar', side));
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/NOT VERIFIED/);
    expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
    // Signed by a key the file does not hold.
    const other = await makeCopy(randomBytes(100), generateSigningKey());
    r = node(withPass('verify', kf, other.side, other.enc));
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(
      /claims the verify key .*not in the key file, so that claim is not checked/,
    );
    expect(r.stderr.toString()).not.toMatch(/trust/);
    // A good sidecar under another copy's name.
    const good = await makeCopy(randomBytes(100));
    fs.copyFileSync(
      good.side,
      path.join(dir, 'backup-2026-11-01T02-00-00-000-abcdef12.tar.gz.enc.json'),
    );
    r = node(
      withPass(
        'verify',
        kf,
        path.join(dir, 'backup-2026-11-01T02-00-00-000-abcdef12.tar.gz.enc.json'),
      ),
    );
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/its signature is for/);
    // No signature at all.
    fs.writeFileSync(side, JSON.stringify({ installId: INSTALL }));
    r = node(withPass('verify', kf, side));
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/not signed/);
  });

  it('a sidecar signed by the script rules matches the API byte for byte (test vector)', () => {
    // The script has no signing command; it shares the vector through
    // verify: the vector's sidecar verifies with the vector's key.
    const k = signingKeyFromSeed(Buffer.alloc(32, 7));
    const j = { signature: signManifest(archive(), k) };
    fs.writeFileSync(path.join(dir, `${NAME}.enc.json`), JSON.stringify(j));
    return sealKeyFile(key, PASS, { logN: 14, verifyKeys: [k.verifyKey.text] }).then((file) => {
      fs.writeFileSync(path.join(dir, 'k.ggkey'), file);
      const r = node(
        withPass('verify', path.join(dir, 'k.ggkey'), path.join(dir, `${NAME}.enc.json`)),
      );
      expect(r.status).toBe(0);
      expect(r.stdout.toString()).toContain(
        'Verified: signed by the verify key 058d-7940-89ab-a15b-eb25-76ac-2168-1b43',
      );
    });
  });

  it('fingerprint and public show verify keys', async () => {
    let r = node(['fingerprint', signer.verifyKey.text]);
    expect(r.stdout.toString().trim()).toBe(signer.verifyKey.fingerprintText);
    fs.writeFileSync(
      path.join(dir, 'k.ggkey'),
      await sealKeyFile(key, PASS, { logN: 14, verifyKeys: [signer.verifyKey.text] }),
    );
    r = node(withPass('public', path.join(dir, 'k.ggkey')));
    expect(r.stdout.toString()).toContain(`Verify key:  ${signer.verifyKey.text}`);
  });

  it('the API refuses a key file with a damaged verify key list', async () => {
    const bad = await sealKeyFile(key, PASS, { logN: 14, verifyKeys: ['ggver1:nope'] });
    await expect(openKeyFile(bad, PASS)).rejects.toThrow(/verify keys is not valid|verify keys/);
  });
});
