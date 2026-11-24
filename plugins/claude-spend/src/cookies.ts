// Claude Desktop's claude.ai session cookies, read through its Chromium cookie
// store (port of the Swift SessionCookieProvider):
//
//  1. A cookie the user pasted on the plugin's page (a plugin secret) wins
//     over the automatic chain.
//  2. The Keychain "Claude Safe Storage" password, via the `security` tool
//     (service-named lookup; the account name misses the item).
//  3. Chromium's PBKDF2 → AES-128-CBC recipe against the cookie DB, COPIED
//     (with its journal) to a private temp dir first, because sqlite locks
//     while Claude Desktop runs, and DELETED in a `finally` on every call: no
//     decrypted-cookie residue outlives a poll.
//
// Nothing is cached between calls. A cookie is a live login credential: it
// lives in memory for one fetch and never reaches a log line, an error message,
// or settings. Errors below carry remediation text, never cookie material.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { PluginStorage } from '@workbar/sdk';
import { decryptValue, deriveKey } from './cookie-crypt.js';

export interface CookiePair { readonly name: string; readonly value: string; readonly domain: string }

/** Injectable cookie source (faked in the plugin tests). */
export interface CookieSource {
  /** All claude.ai cookies, ready to replay. Rejects with a SessionCookieError. */
  cookies(): Promise<CookiePair[]>;
  /** Existence only, for the settings page's footnote: never the value. */
  readonly usingSavedCookie: boolean;
  invalidate(): void;
}

export const KEYCHAIN_SERVICE = 'Claude Safe Storage';
/** The pasted override's secret name (letters, digits, . _ -: a valid host secret name). */
export const SAVED_COOKIE_SECRET = 'sessionCookie';
/** Distinctive temp prefix so the shredding guarantee is testable. */
export const TEMP_PREFIX = 'claudespend-cookie-copy-';
export const KEYCHAIN_TIMEOUT_MS = 60_000; // the user may be answering a Keychain prompt

export type CookieFailure = 'keychainDenied' | 'keychainItemMissing' | 'cookieDatabaseMissing' | 'cookieDatabaseBusy' | 'noClaudeCookies';

/** The plugin maps keychainDenied / keychainItemMissing / cookieDatabaseMissing / noClaudeCookies to the
 *  auth state; cookieDatabaseBusy is transient (stale, not auth). */
export class SessionCookieError extends Error {
  constructor(readonly kind: CookieFailure, detail = '') {
    super(describe(kind, detail));
    this.name = 'SessionCookieError';
  }
}

function describe(kind: CookieFailure, detail: string): string {
  switch (kind) {
    case 'keychainDenied': return `Keychain access to “Claude Safe Storage” was denied (${detail}) — approve the prompt, or paste a session cookie on this page`;
    case 'keychainItemMissing': return 'no “Claude Safe Storage” item in the Keychain — launch Claude Desktop once, or paste a session cookie on this page';
    case 'cookieDatabaseMissing': return `Claude Desktop’s cookie database wasn’t found at ${detail} — launch Claude Desktop and sign in, or paste a session cookie on this page`;
    case 'cookieDatabaseBusy': return `Claude Desktop’s cookie database couldn’t be read (${detail}) — will retry on the next poll`;
    case 'noClaudeCookies': return 'no claude.ai cookies in Claude Desktop — sign in to Claude Desktop';
  }
}

/** Reads the Safe Storage password. Throws SessionCookieError. */
export type KeychainRead = (service: string) => Promise<string>;

/** A Keychain reader over a `security`-compatible executable (injectable so tests use stubs, never the real Keychain).
 *  `security find-generic-password -w -s <service>` prints only the password. */
export function makeSecurityKeychainRead(bin = '/usr/bin/security', timeoutMs = KEYCHAIN_TIMEOUT_MS): KeychainRead {
  return service => new Promise((resolve, reject) => {
    execFile(bin, ['find-generic-password', '-w', '-s', service], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 16 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.replace(/\r?\n$/, ''));
      const e = error as { code?: unknown; killed?: boolean };
      if (e.code === 44 || /could not be found/i.test(String(stderr))) return reject(new SessionCookieError('keychainItemMissing')); // exit 44: errSecItemNotFound
      // User clicked Deny (exit 51 / "User canceled"), a stale ACL, a timeout… all the re-approval path.
      reject(new SessionCookieError('keychainDenied', typeof e.code === 'number' ? `security exit ${e.code}` : e.killed ? 'timed out waiting for the prompt' : 'security failed'));
    });
  });
}

export const securityKeychainRead: KeychainRead = makeSecurityKeychainRead();

export interface CookieProviderOptions {
  /** The pasted override, read each call. */
  readonly savedCookie: () => Promise<string | undefined>;
  readonly storage: Pick<PluginStorage, 'openReadOnly'>;
  readonly cookieDatabase?: string;
  readonly keychainRead?: KeychainRead;
  readonly tmpDir?: string;
}

export const defaultCookieDatabase = (): string => path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'Cookies');

export class SessionCookieProvider implements CookieSource {
  usingSavedCookie = false;
  private readonly db: string;
  private readonly read: KeychainRead;
  private readonly tmp: string;

  constructor(private readonly o: CookieProviderOptions) {
    this.db = o.cookieDatabase ?? defaultCookieDatabase();
    this.read = o.keychainRead ?? securityKeychainRead;
    this.tmp = o.tmpDir ?? os.tmpdir();
  }

  /** Nothing is cached, so the 401-retry re-reads by construction. */
  invalidate(): void {}

  async cookies(): Promise<CookiePair[]> {
    // 1. The pasted override: a raw Cookie header or "name=value".
    const saved = await this.o.savedCookie();
    if (saved !== undefined && saved.trim() !== '') { this.usingSavedCookie = true; return parseCookieHeader(saved); }
    this.usingSavedCookie = false;

    // 2. The Safe Storage password → AES key.
    const key = deriveKey(await this.read(KEYCHAIN_SERVICE));
    try {
      // 3. Copy DB + journal to a private dir, read the copy, delete everything.
      if (!fs.existsSync(this.db)) throw new SessionCookieError('cookieDatabaseMissing', this.db);
      const dir = fs.mkdtempSync(path.join(this.tmp, TEMP_PREFIX)); // mkdtemp creates it 0700
      try {
        const copy = path.join(dir, 'Cookies');
        try {
          fs.copyFileSync(this.db, copy);
          for (const ext of ['-journal', '-wal']) if (fs.existsSync(this.db + ext)) fs.copyFileSync(this.db + ext, copy + ext);
        } catch (e) { throw new SessionCookieError('cookieDatabaseBusy', `copy failed: ${errCode(e)}`); }

        let rows: Row[];
        try {
          const db = await this.o.storage.openReadOnly(copy);
          try {
            rows = await db.all<Row>("SELECT host_key, name, value, encrypted_value FROM cookies WHERE host_key = 'claude.ai' OR host_key LIKE '%.claude.ai'");
          } finally { await db.close().catch(() => {}); }
        } catch (e) { throw new SessionCookieError('cookieDatabaseBusy', `open/query failed: ${errCode(e)}`); }

        const pairs: CookiePair[] = [];
        for (const r of rows) {
          // LIKE '%.claude.ai' also matches a host like "x.claude.ai" but never "evilclaude.ai" (the dot is literal).
          if (typeof r.host_key !== 'string' || typeof r.name !== 'string' || r.name === '') continue;
          let value: string | null = null;
          if (typeof r.value === 'string' && r.value !== '') value = r.value;
          else if (r.encrypted_value instanceof Uint8Array && r.encrypted_value.length > 0) value = decryptValue(r.encrypted_value, r.host_key, key);
          if (value !== null) pairs.push({ name: r.name, value, domain: r.host_key });
        }
        if (pairs.length === 0) throw new SessionCookieError('noClaudeCookies');
        return pairs;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); } // the shred: no /tmp residue
    } finally { key.fill(0); }
  }
}

interface Row { host_key: unknown; name: unknown; value: unknown; encrypted_value: unknown }

/** An error's code/name only: SQLite and fs messages can quote paths, never cookie values, but keep it minimal. */
const errCode = (e: unknown): string => (e as { code?: string }).code ?? (e instanceof Error ? e.name : 'error');

/** Parses a pasted Cookie header ("a=1; b=2") or bare "a=1" into pairs. */
export function parseCookieHeader(raw: string): CookiePair[] {
  const out: CookiePair[] = [];
  for (const piece of raw.split(';')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const name = piece.slice(0, i).trim(); const value = piece.slice(i + 1).trim();
    if (name !== '' && value !== '') out.push({ name, value, domain: 'claude.ai' });
  }
  return out;
}

/** The replay header. All claude.ai cookies are replayed (the probe only passed with the full set,
 *  Cloudflare clearance included). */
export const cookieHeader = (pairs: readonly CookiePair[]): string => pairs.map(p => `${p.name}=${p.value}`).join('; ');
