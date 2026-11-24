// The Chromium macOS cookie crypto (port of the Swift CookieCrypt):
//   1. key   = PBKDF2-HMAC-SHA1(Safe Storage password, "saltysalt", 1003, 16 B)
//   2. value = AES-128-CBC(key, IV = 16 × 0x20), PKCS7-padded
//   3. stored as "v10" ‖ ciphertext; newer Chromium prepends a 32-byte
//      SHA256(host_key) to the PLAINTEXT, verified against host_key before
//      stripping.
// Cookie values are live login credentials: nothing here logs or throws a value.
import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20);
const DIGEST_LENGTH = 32;

/** PBKDF2-HMAC-SHA1 → the AES key. Known-answer tested against independently computed vectors. */
export function deriveKey(password: Buffer | string): Buffer {
  return pbkdf2Sync(typeof password === 'string' ? Buffer.from(password, 'utf8') : password, SALT, ITERATIONS, KEY_LENGTH, 'sha1');
}

/** The 32-byte domain digest newer Chromium prepends to the plaintext. */
export function domainDigest(hostKey: string): Buffer {
  return createHash('sha256').update(hostKey, 'utf8').digest();
}

/** AES-128-CBC decrypt (PKCS7 removed). null on any crypto failure (bad padding, wrong length). */
export function aesDecrypt(payload: Uint8Array, key: Buffer): Buffer | null {
  try {
    const d = createDecipheriv('aes-128-cbc', key, IV);
    return Buffer.concat([d.update(payload), d.final()]);
  } catch { return null; }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const text = (b: Uint8Array): string | null => { try { return utf8.decode(b); } catch { return null; } };

/**
 * Decrypts one `encrypted_value` for `hostKey`. null when nothing usable comes out.
 *  - "v10" + digest match    → strip the 32-byte prefix (current format)
 *  - "v10" + digest mismatch → keep the whole plaintext (the pre-digest format's
 *                              first bytes are real cookie bytes; trust the bytes over the tag)
 *  - other prefix            → UTF-8 pass-through (unknown future format: hand back what decodes)
 *  - not valid UTF-8         → null for this cookie
 */
export function decryptValue(encrypted: Uint8Array, hostKey: string, key: Buffer): string | null {
  if (encrypted.length <= 3) return null;
  const buf = Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  if (buf.subarray(0, 3).toString('latin1') === 'v10') {
    const plain = aesDecrypt(buf.subarray(3), key);
    if (!plain) return null;
    // The digest is compared on RAW bytes: a hash is never valid UTF-8, so a
    // whole-plaintext UTF-8 gate would reject every current-format cookie.
    const digest = domainDigest(hostKey);
    if (plain.length >= DIGEST_LENGTH && timingSafeEqual(plain.subarray(0, DIGEST_LENGTH), digest)) return text(plain.subarray(DIGEST_LENGTH));
    return text(plain);
  }
  return text(buf);
}
