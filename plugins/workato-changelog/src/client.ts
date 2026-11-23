// Port of WorkatoClient.swift over ctx.http (Electron net.fetch).
import type { HttpClient } from '@workbar/sdk';

export const BASE_URL = 'https://www.workato.com/product-hub/changelog/';
// Identify as a browser so the CDN serves the markup a reader sees.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export type WorkatoClientErrorKind = 'network' | 'timeout' | 'badResponse' | 'http';

export class WorkatoClientError extends Error {
  constructor(readonly kind: WorkatoClientErrorKind, readonly detail: string, readonly status?: number) {
    super(kind === 'network' ? `Workato unreachable: ${detail}`
      : kind === 'timeout' ? 'Workato didn’t answer within the timeout'
      : kind === 'badResponse' ? `Workato’s response couldn’t be read: ${detail}`
      : `Workato returned HTTP ${status}`);
    this.name = 'WorkatoClientError';
  }
}

export class WorkatoClient {
  constructor(private readonly http: HttpClient, private readonly timeoutMs = 30_000) {}

  /** One archive page's HTML, or null past the last page (404: end of history, not an error). */
  async fetchPage(page: number): Promise<string | null> {
    const url = page <= 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    let res: { status: number; text: string };
    try {
      res = await this.http.fetch(url, { headers: { accept: 'text/html', 'user-agent': USER_AGENT }, timeoutMs: this.timeoutMs });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/timed out/i.test(message)) throw new WorkatoClientError('timeout', message);
      throw new WorkatoClientError('network', message);
    }
    if (res.status === 404) return null;
    if (res.status < 200 || res.status > 299) throw new WorkatoClientError('http', `HTTP ${res.status}`, res.status);
    return res.text;
  }
}
