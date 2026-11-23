// Test helpers: fixtures, a fake HttpClient, a mock token provider and stub
// helper scripts (the real corporate helper is never run from tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpClient } from '@workbar/sdk';
import type { TokenProvider } from '../src/gateway.js';

export const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.json`), 'utf8');
export const CANARY = 'canary-gateway-token-123';

export interface Call { url: string; method: string; headers: Record<string, string> }

/** Answers with `handler` (default: the live fixture); `error` throws; `delayMs` stalls. */
export function fakeHttp(o: { handler?: (c: Call) => [number, string]; error?: Error; delayMs?: number } = {}):
  HttpClient & { calls: Call[]; handler: ((c: Call) => [number, string]) | undefined; error: Error | undefined; delayMs: number } {
  const http = {
    calls: [] as Call[],
    handler: o.handler,
    error: o.error,
    delayMs: o.delayMs ?? 0,
    fetch: async (url: string, init: { method?: string; headers?: Readonly<Record<string, string>> } = {}) => {
      http.calls.push({ url, method: init.method ?? 'GET', headers: { ...init.headers } });
      if (http.error) throw http.error;
      if (http.delayMs) await new Promise(r => setTimeout(r, http.delayMs));
      const [status, text] = http.handler?.(http.calls.at(-1)!) ?? [200, fixture('budget-status-live')];
      return { status, text, headers: {} };
    },
  };
  return http;
}

export class MockTokenProvider implements TokenProvider {
  calls = 0;
  invalidates = 0;
  error: Error | null = null;
  usingSavedToken = false;
  async currentToken(): Promise<string> {
    this.calls++;
    if (this.error) throw this.error;
    return CANARY;
  }
  invalidate(): void { this.invalidates++; }
}

/** A payload with the given spend/percentage for "30d"; the reset is in the future. */
export function payload(spend: number, percentage: number, max = 900): string {
  return JSON.stringify({
    user_id: 'u', generated_at: '2026-11-18T17:52:34+00:00',
    budget_limits: [{ budget_duration: '30d', max_budget: max, current_spend: spend, used_percentage: percentage, reset_at: new Date(Date.now() + 12 * 86_400_000).toISOString() }],
  });
}

/** An executable sh script in a fresh temp folder; returns its path. */
export function stubHelper(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-budget-helper-'));
  const file = path.join(dir, 'claude-code-helper');
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return file;
}
