// Ported from SessionCookieProviderTests (provider half). Real files, real
// SQLite, real crypto: a synthetic Claude Desktop cookie database is built with
// node:sqlite and encrypted with the Chromium recipe, so nothing between the
// code and the failure modes is mocked. The Keychain and the real cookie
// database are NEVER touched (both are injected).
import { createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginStorage } from '@workbar/sdk';
import { deriveKey, domainDigest } from '../src/cookie-crypt.js';
import { cookieHeader, KEYCHAIN_SERVICE, makeSecurityKeychainRead, parseCookieHeader, SessionCookieError, SessionCookieProvider, TEMP_PREFIX, type KeychainRead } from '../src/cookies.js';

const PASSWORD = 'test-password-123';
const KEY = deriveKey(PASSWORD);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-')); dirs.push(d); return d; };

const encrypt = (plain: string, hostKey: string, withDigest: boolean) => {
  const body = Buffer.concat([withDigest ? domainDigest(hostKey) : Buffer.alloc(0), Buffer.from(plain)]);
  const c = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(body), c.final()]);
};

interface Row { hostKey: string; name: string; plain: string; encrypted: boolean; withDigest: boolean }
function makeDatabase(rows: Row[]): string {
  const file = path.join(tmp(), 'Cookies');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL DEFAULT \'\', encrypted_value BLOB)');
  const ins = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)');
  for (const r of rows) ins.run(r.hostKey, r.name, r.encrypted ? '' : r.plain, r.encrypted ? encrypt(r.plain, r.hostKey, r.withDigest) : new Uint8Array(0));
  db.close();
  return file;
}

/** Real node:sqlite read-only storage, like the host's ctx.storage.openReadOnly. */
const storage: Pick<PluginStorage, 'openReadOnly'> = {
  openReadOnly: async file => {
    const db = new DatabaseSync(file, { readOnly: true });
    return { all: async (sql: string, p: readonly unknown[] = []) => db.prepare(sql).all(...(p as never[])) as never, get: async () => undefined, run: async () => ({ changes: 0 }), close: async () => { db.close(); } } as never;
  },
};

const provider = (file: string, extra: { saved?: string; keychainRead?: KeychainRead; tmpDir?: string } = {}) =>
  new SessionCookieProvider({ savedCookie: async () => extra.saved, storage, cookieDatabase: file, keychainRead: extra.keychainRead ?? (async () => PASSWORD), ...(extra.tmpDir ? { tmpDir: extra.tmpDir } : {}) });

const kindOf = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return e instanceof SessionCookieError ? e.kind : `untyped: ${e}`; } };

describe('SessionCookieProvider', () => {
  it('a synthetic cookie DB decrypts both v10 plaintext forms (digest and no digest)', async () => {
    const file = makeDatabase([
      { hostKey: 'claude.ai', name: 'sessionKey', plain: 'sk-ant-session-xyz', encrypted: true, withDigest: true },   // newer Chromium: SHA256(host) prefix
      { hostKey: 'claude.ai', name: 'cf_clearance', plain: 'cf-token-1', encrypted: true, withDigest: false },        // older: no prefix
    ]);
    const pairs = await provider(file).cookies();
    expect(pairs).toContainEqual({ name: 'sessionKey', value: 'sk-ant-session-xyz', domain: 'claude.ai' });
    expect(pairs).toContainEqual({ name: 'cf_clearance', value: 'cf-token-1', domain: 'claude.ai' });
  });

  it('only claude.ai cookies are read; other hosts and plaintext values pass through as-is', async () => {
    const file = makeDatabase([
      { hostKey: 'claude.ai', name: 'sessionKey', plain: 'enc-value', encrypted: true, withDigest: true },
      { hostKey: '.claude.ai', name: 'subdomainCookie', plain: 'sub-value', encrypted: true, withDigest: true },
      { hostKey: 'example.com', name: 'sessionKey', plain: 'not-claude', encrypted: true, withDigest: true },
      { hostKey: 'evilclaude.ai', name: 'spoof', plain: 'not-claude-either', encrypted: true, withDigest: true }, // LIKE '%.claude.ai' must not match
      { hostKey: 'claude.ai', name: 'plainCookie', plain: 'plain-value', encrypted: false, withDigest: false },
    ]);
    const pairs = await provider(file).cookies();
    expect(pairs).toHaveLength(3);
    expect(pairs.some(p => p.domain === 'example.com')).toBe(false);
    expect(pairs.some(p => p.domain === 'evilclaude.ai')).toBe(false);
    expect(pairs).toContainEqual({ name: 'plainCookie', value: 'plain-value', domain: 'claude.ai' });
    expect(pairs).toContainEqual({ name: 'subdomainCookie', value: 'sub-value', domain: '.claude.ai' });
  });

  it('a cookie that fails to decrypt is skipped, the rest still come through', async () => {
    const file = makeDatabase([{ hostKey: 'claude.ai', name: 'good', plain: 'ok', encrypted: true, withDigest: true }]);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)').run('claude.ai', 'bad', '', Buffer.concat([Buffer.from('v10'), Buffer.alloc(16)]));
    db.close();
    expect(await provider(file).cookies()).toEqual([{ name: 'good', value: 'ok', domain: 'claude.ai' }]);
  });

  it('a denied Keychain read is a typed error with the re-approval remediation', async () => {
    const p = provider('/nonexistent/Cookies', { keychainRead: async () => { throw new SessionCookieError('keychainDenied', 'security exit 51'); } });
    await expect(p.cookies()).rejects.toThrow(/approve the prompt/);
    expect(await kindOf(p.cookies())).toBe('keychainDenied');
  });

  it('a missing Safe Storage item suggests launching Claude Desktop', async () => {
    const p = provider('/nonexistent/Cookies', { keychainRead: async () => { throw new SessionCookieError('keychainItemMissing'); } });
    expect(await kindOf(p.cookies())).toBe('keychainItemMissing');
    await expect(p.cookies()).rejects.toThrow(/launch Claude Desktop once/);
  });

  it('a missing cookie DB is the open-Claude-Desktop remediation', async () => {
    expect(await kindOf(provider('/nonexistent/Claude/Cookies').cookies())).toBe('cookieDatabaseMissing');
  });

  it('a corrupt DB copy is the transient busy error, not auth', async () => {
    const file = path.join(tmp(), 'Cookies');
    fs.writeFileSync(file, 'definitely not sqlite');
    const p = provider(file);
    expect(await kindOf(p.cookies())).toBe('cookieDatabaseBusy');
    await expect(p.cookies()).rejects.toThrow(/next poll/); // retry, not sign in
  });

  it('a readable DB with no claude.ai cookies means signed out', async () => {
    const file = makeDatabase([{ hostKey: 'example.com', name: 'sessionKey', plain: 'elsewhere', encrypted: true, withDigest: true }]);
    expect(await kindOf(provider(file).cookies())).toBe('noClaudeCookies');
  });

  it('the pasted override wins over the automatic chain and never touches the Keychain or the DB', async () => {
    let keychainRead = false;
    const p = provider('/nonexistent/Claude/Cookies', { saved: 'sessionKey=pasted-cookie-1; other=pasted-2', keychainRead: async () => { keychainRead = true; return PASSWORD; } });
    expect(await p.cookies()).toEqual([
      { name: 'sessionKey', value: 'pasted-cookie-1', domain: 'claude.ai' },
      { name: 'other', value: 'pasted-2', domain: 'claude.ai' },
    ]);
    expect(p.usingSavedCookie).toBe(true);
    expect(keychainRead).toBe(false);
  });

  it('a blank pasted value is no override', async () => {
    const file = makeDatabase([{ hostKey: 'claude.ai', name: 'sessionKey', plain: 'from-db', encrypted: true, withDigest: true }]);
    const p = provider(file, { saved: '   ' });
    expect((await p.cookies())[0]!.value).toBe('from-db');
    expect(p.usingSavedCookie).toBe(false);
  });

  it('every read deletes its temp dir: no decrypted-cookie residue, on success or failure', async () => {
    const scratch = tmp(); // a private $TMPDIR, so the check can't be confused by other runs
    const residue = () => fs.readdirSync(scratch).filter(n => n.startsWith(TEMP_PREFIX));
    const ok = makeDatabase([{ hostKey: 'claude.ai', name: 'sessionKey', plain: 'shred-me', encrypted: true, withDigest: true }]);
    await provider(ok, { tmpDir: scratch }).cookies();
    await provider(ok, { tmpDir: scratch }).cookies(); // twice: per-call lifecycle
    expect(residue()).toEqual([]);
    const empty = makeDatabase([{ hostKey: 'example.com', name: 'x', plain: 'y', encrypted: true, withDigest: true }]);
    await provider(empty, { tmpDir: scratch }).cookies().catch(() => {});
    const corrupt = path.join(tmp(), 'Cookies'); fs.writeFileSync(corrupt, 'not sqlite');
    await provider(corrupt, { tmpDir: scratch }).cookies().catch(() => {});
    expect(residue()).toEqual([]);
  });

  it('the temp dir is private (0700) while it exists', async () => {
    const scratch = tmp();
    let seen = -1;
    const file = makeDatabase([{ hostKey: 'claude.ai', name: 'a', plain: 'b', encrypted: true, withDigest: true }]);
    const spying: Pick<PluginStorage, 'openReadOnly'> = { openReadOnly: async f => { seen = fs.statSync(path.dirname(f)).mode & 0o777; return storage.openReadOnly(f); } };
    await new SessionCookieProvider({ savedCookie: async () => undefined, storage: spying, cookieDatabase: file, keychainRead: async () => PASSWORD, tmpDir: scratch }).cookies();
    expect(seen).toBe(0o700);
  });

  it('a journal next to the DB is copied with it', async () => {
    const file = makeDatabase([{ hostKey: 'claude.ai', name: 'a', plain: 'b', encrypted: true, withDigest: true }]);
    fs.writeFileSync(file + '-journal', '');
    let copiedJournal = false;
    const spying: Pick<PluginStorage, 'openReadOnly'> = { openReadOnly: async f => { copiedJournal = fs.existsSync(f + '-journal'); return storage.openReadOnly(f); } };
    await new SessionCookieProvider({ savedCookie: async () => undefined, storage: spying, cookieDatabase: file, keychainRead: async () => PASSWORD }).cookies();
    expect(copiedJournal).toBe(true);
  });

  it('the replay header joins all cookies; parsing is tolerant of the pasted form', () => {
    expect(cookieHeader([{ name: 'sessionKey', value: 'abc', domain: 'claude.ai' }, { name: 'cf_clearance', value: 'def', domain: '.claude.ai' }])).toBe('sessionKey=abc; cf_clearance=def');
    expect(parseCookieHeader(' sessionKey = abc ;  x = y=1 ')).toEqual([
      { name: 'sessionKey', value: 'abc', domain: 'claude.ai' },
      { name: 'x', value: 'y=1', domain: 'claude.ai' },
    ]);
    expect(parseCookieHeader('not-a-cookie')).toEqual([]);
  });

  it('error messages never contain a cookie value or the Keychain password', async () => {
    const secret = 'sk-ant-VERY-SECRET-VALUE';
    const file = makeDatabase([{ hostKey: 'claude.ai', name: 'sessionKey', plain: secret, encrypted: true, withDigest: true }]);
    const corrupt = path.join(tmp(), 'Cookies'); fs.writeFileSync(corrupt, 'junk');
    for (const p of [provider(corrupt), provider('/nope/Cookies'), provider(file, { keychainRead: async () => { throw new SessionCookieError('keychainDenied', 'x'); } })]) {
      const m = await p.cookies().then(() => '', (e: Error) => e.message);
      expect(m).not.toContain(secret);
      expect(m).not.toContain(PASSWORD);
    }
  });

  describe('the Keychain read (stub executables: the real Keychain is never touched)', () => {
    /** An executable sh script; its argv is written to `<dir>/args` so the call shape can be checked. */
    const stub = (body: string) => {
      const dir = tmp(); const file = path.join(dir, 'security');
      fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\n${body}\n`, { mode: 0o755 });
      return { file, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n') };
    };

    it('returns the password without its trailing newline, and asks for the service by name with -w', async () => {
      const s = stub('printf "hunter2\\n"');
      expect(await makeSecurityKeychainRead(s.file)(KEYCHAIN_SERVICE)).toBe('hunter2');
      expect(s.args()).toEqual(['find-generic-password', '-w', '-s', 'Claude Safe Storage']);
    });

    it('keeps a password that has internal spaces or ends with a space, stripping only the final newline', async () => {
      expect(await makeSecurityKeychainRead(stub('printf "a b c \\n"').file)('x')).toBe('a b c ');
    });

    it('exit 44 (errSecItemNotFound) is "item missing", not "denied"', async () => {
      const s = stub('echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44');
      expect(await kindOf(makeSecurityKeychainRead(s.file)(KEYCHAIN_SERVICE))).toBe('keychainItemMissing');
    });

    it('exit 44 alone is "item missing" even when stderr says nothing useful', async () => {
      expect(await kindOf(makeSecurityKeychainRead(stub('exit 44').file)(KEYCHAIN_SERVICE))).toBe('keychainItemMissing');
    });

    it('"could not be found" on stderr is also "item missing" whatever the exit code', async () => {
      const s = stub('echo "The specified item could not be found in the keychain." >&2; exit 1');
      expect(await kindOf(makeSecurityKeychainRead(s.file)(KEYCHAIN_SERVICE))).toBe('keychainItemMissing');
    });

    it('any other failure (the user clicked Deny, a stale ACL) is "denied" with the exit code and never the stderr text', async () => {
      const s = stub('echo "User canceled the authorization. password=SHOULD-NOT-LEAK" >&2; exit 51');
      const e = await makeSecurityKeychainRead(s.file)(KEYCHAIN_SERVICE).catch((x: Error) => x) as SessionCookieError;
      expect(e.kind).toBe('keychainDenied');
      expect(e.message).toContain('security exit 51');
      expect(e.message).toContain('approve the prompt');
      expect(e.message).not.toContain('SHOULD-NOT-LEAK');
    });

    it('a prompt nobody answers times out as "denied", not a hang', async () => {
      const s = stub('sleep 5');
      const e = await makeSecurityKeychainRead(s.file, 150)(KEYCHAIN_SERVICE).catch((x: Error) => x) as SessionCookieError;
      expect(e.kind).toBe('keychainDenied');
      expect(e.message).toContain('timed out');
    });

    it('a missing security binary is "denied" (remediation shown), not a crash', async () => {
      expect(await kindOf(makeSecurityKeychainRead('/nonexistent/security')(KEYCHAIN_SERVICE))).toBe('keychainDenied');
    });

    it('end to end: a password from the stub decrypts a synthetic cookie DB', async () => {
      const file = makeDatabase([{ hostKey: 'claude.ai', name: 'sessionKey', plain: 'via-stub', encrypted: true, withDigest: true }]);
      const s = stub(`printf "${PASSWORD}\\n"`);
      expect(await provider(file, { keychainRead: makeSecurityKeychainRead(s.file) }).cookies()).toEqual([{ name: 'sessionKey', value: 'via-stub', domain: 'claude.ai' }]);
    });
  });
});
