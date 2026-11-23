// Port of MuleSoftClient.swift over ctx.http (Electron net.fetch). Unlike the
// Workato client, a 404 throws: the runner decides per page type whether
// that is fatal (the index) or tolerated (a product page, retried next run).
import type { HttpClient } from '@workbar/sdk';

// Identify as a browser so the CDN serves the markup a reader sees.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export type MuleSoftClientErrorKind = 'network' | 'timeout' | 'badResponse' | 'http';

export class MuleSoftClientError extends Error {
  constructor(readonly kind: MuleSoftClientErrorKind, readonly detail: string, readonly status?: number) {
    super(kind === 'network' ? `docs.mulesoft.com unreachable: ${detail}`
      : kind === 'timeout' ? 'docs.mulesoft.com didn’t answer within the timeout'
      : kind === 'badResponse' ? `docs.mulesoft.com’s response couldn’t be read: ${detail}`
      : `docs.mulesoft.com returned HTTP ${status}`);
    this.name = 'MuleSoftClientError';
  }
}

export class MuleSoftClient {
  constructor(private readonly http: HttpClient, private readonly timeoutMs = 30_000) {}

  /** One page's HTML; throws MuleSoftClientError for anything but 2xx. */
  async fetch(url: string): Promise<string> {
    let res: { status: number; text: string };
    try {
      res = await this.http.fetch(url, { headers: { accept: 'text/html', 'user-agent': USER_AGENT }, timeoutMs: this.timeoutMs });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/timed out/i.test(message)) throw new MuleSoftClientError('timeout', message);
      throw new MuleSoftClientError('network', message);
    }
    if (res.status < 200 || res.status > 299) throw new MuleSoftClientError('http', `HTTP ${res.status}`, res.status);
    return res.text;
  }
}
