import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for stored credentials (#36).
 *
 * Master key comes from CREDENTIAL_ENCRYPTION_KEY env var, base64-
 * encoded 32 bytes. The IV is per-row, 12 random bytes. The item id
 * is used as additional authenticated data (AAD) so a row can't be
 * moved between items without invalidating the GCM tag at decrypt
 * time.
 *
 * Encrypted payload format on disk: base64(ciphertext || authTag).
 * The 16-byte tag is appended to the ciphertext so we have one
 * blob to store and the IV is the only sibling field. Decrypt
 * splits the trailing 16 bytes off the end.
 */

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

/**
 * Load the master encryption key from CREDENTIAL_ENCRYPTION_KEY.
 * Cached after the first read so we don't re-decode on every
 * encrypt / decrypt call. Throws synchronously if the env var is
 * missing or malformed -- a deployment without a key cannot store
 * credentials at all, and silently failing would let plaintext
 * leak the next time someone tries.
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be base64-encoded.');
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length}).`,
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypt a plaintext string for storage. Returns the IV and the
 * combined ciphertext+tag, both base64-encoded so they can be
 * dropped straight into TEXT columns. `aad` is bound into the
 * GCM tag; pass the item id so a row can't silently move between
 * items at the SQL level.
 */
export function encryptCredential(
  plaintext: string,
  aad: string,
): { ciphertext: string; iv: string } {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypt a stored credential. Throws if the AAD (item id) does
 * not match what was encrypted, the key is wrong, or the payload
 * has been tampered with -- callers should treat any thrown
 * Error from this function as "credential unusable, behave as if
 * the item has no credential."
 */
export function decryptCredential(
  ciphertext: string,
  iv: string,
  aad: string,
): string {
  const key = loadKey();
  const ivBuf = Buffer.from(iv, 'base64');
  if (ivBuf.length !== IV_LENGTH) {
    throw new Error(`IV must be ${IV_LENGTH} bytes after base64 decode.`);
  }
  const combined = Buffer.from(ciphertext, 'base64');
  if (combined.length <= TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain a GCM tag.');
  }
  const ct = combined.subarray(0, combined.length - TAG_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * Test-only helper: clear the cached key. Lets test setup mutate
 * CREDENTIAL_ENCRYPTION_KEY between cases without restarting the
 * Node process. Not exported through the items service; only
 * called directly from test files.
 */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}
