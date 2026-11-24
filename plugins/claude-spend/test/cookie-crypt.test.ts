// Ported from SessionCookieProviderTests (crypto half). The vectors are
// independent of this code: PBKDF2 outputs from Python's hashlib (the same
// constants the Swift tests pin), and AES ciphertext produced by `openssl enc
// -aes-128-cbc` — so a bug that is symmetric in our own encrypt/decrypt cannot
// hide here.
import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesDecrypt, decryptValue, deriveKey, domainDigest } from '../src/cookie-crypt.js';

const KEY = deriveKey('test-password-123');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const v10 = (cipherHex: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(cipherHex, 'hex')]);

// openssl enc -aes-128-cbc -K 4297e028… -iv 2020…20, plaintext as noted
const OPENSSL = {
  withDigest: '107bfdfac994be117ad9c080e07d071afbd1b40e4eaa54d097ebbd14102fcbb1333ff2e05bc1acbc54f30c64790c68013f46cb6c087acd5553d195ab7216ce93', // sha256("claude.ai") ‖ "sk-ant-session-xyz"
  noDigest: 'bf36e8ac87376019dbe05f82acee535d',                                                                                                       // "cf-token-1"
  mismatch: '9ced5d8b5e9249ba30b0a8bf8e69f5b7e6a2c91e7e1b26b72a5fda32faac52a21661a9eaa670bad57d47ec6c1d21e31f',                                         // 32 × "A" ‖ "value"
};

/** Our own encrypt, for round trips only (the vectors above are the real check). */
const encrypt = (plain: Buffer) => { const c = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20)); return Buffer.concat([c.update(plain), c.final()]); };

describe('cookie crypto', () => {
  it('PBKDF2-HMAC-SHA1 matches independently computed vectors', () => {
    // hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt', 1003, 16)
    expect(hex(deriveKey('peanuts'))).toBe('d9a09d499b4e1b7461f28e67972c6dbd');
    // hashlib.pbkdf2_hmac('sha1', b'test-password-123', b'saltysalt', 1003, 16)
    expect(hex(KEY)).toBe('4297e0283a170e06d6639497f4ff58c4');
    expect(deriveKey(Buffer.from('peanuts'))).toEqual(deriveKey('peanuts'));
  });

  it('the host digest is sha256 of the host key (value from sha256sum)', () => {
    expect(hex(domainDigest('claude.ai'))).toBe('743e483ae01f1fa262d2b2142bdd118d5289bf940191b1f5fcdf820ed3124eba');
  });

  it('AES round-trips for lengths around the block size', () => {
    for (const n of [1, 15, 16, 17, 64]) {
      const plain = Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff));
      expect(aesDecrypt(encrypt(plain), KEY)).toEqual(plain);
    }
  });

  it('decrypts openssl-made ciphertext in both v10 plaintext forms', () => {
    expect(decryptValue(v10(OPENSSL.withDigest), 'claude.ai', KEY)).toBe('sk-ant-session-xyz'); // digest stripped
    expect(decryptValue(v10(OPENSSL.noDigest), 'claude.ai', KEY)).toBe('cf-token-1');           // no digest
  });

  it('the digest is verified against host_key before stripping (match strips, mismatch keeps)', () => {
    // Same ciphertext, a different host: the digest no longer matches, so the 32 bytes are NOT stripped.
    const wrongHost = decryptValue(v10(OPENSSL.withDigest), 'evil.example', KEY);
    expect(wrongHost).toBeNull(); // a raw hash is not valid UTF-8, so nothing usable comes out…
    // …while a plaintext whose first 32 bytes are valid text is kept whole, never blindly stripped.
    const kept = decryptValue(v10(OPENSSL.mismatch), 'claude.ai', KEY);
    expect(kept).toBe('A'.repeat(32) + 'value');
    expect(kept).not.toBe('value');
  });

  it('an unknown version prefix falls back to the UTF-8 heuristic', () => {
    expect(decryptValue(Buffer.from('not-encrypted'), 'claude.ai', KEY)).toBe('not-encrypted');
    expect(decryptValue(Buffer.concat([Buffer.from('v20'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]), 'claude.ai', KEY)).toBeNull();
  });

  it('garbage ciphertext, wrong key and too-short values yield null, never a throw or a garbage value', () => {
    expect(decryptValue(Buffer.concat([Buffer.from('v10'), Buffer.alloc(16)]), 'claude.ai', KEY)).toBeNull(); // bad PKCS7 padding (openssl: "bad decrypt")
    expect(decryptValue(Buffer.concat([Buffer.from('v10'), Buffer.alloc(5)]), 'claude.ai', KEY)).toBeNull(); // not a block multiple
    expect(decryptValue(v10(OPENSSL.noDigest), 'claude.ai', deriveKey('another-password'))).toBeNull();      // wrong key
    expect(decryptValue(Buffer.from('v1'), 'claude.ai', KEY)).toBeNull();
    expect(decryptValue(new Uint8Array(0), 'claude.ai', KEY)).toBeNull();
  });

  it('accepts a Uint8Array view with an offset (what node:sqlite returns for BLOBs)', () => {
    const padded = Buffer.concat([Buffer.from('xxxx'), v10(OPENSSL.noDigest)]);
    expect(decryptValue(new Uint8Array(padded.buffer, padded.byteOffset + 4, padded.length - 4), 'claude.ai', KEY)).toBe('cf-token-1');
  });
});
