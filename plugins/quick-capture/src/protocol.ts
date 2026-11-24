// The messages between the plugin (host process) and the capture bar page (views/panel.*). JSON only, both ways.
//
//   plugin → page
//     {type:'state', mode, column, dateFormat, dateTrigger, tz, nowIso, message?}   sent on every show and on every change
//         mode: 'unconfigured' | 'editing' | 'submitting' | 'success' | 'error'; `message` for success/error
//   page → plugin
//     {type:'submit', text}     Enter pressed with text
//     {type:'openSettings'}     the gear, the error link, or the unconfigured row
//     {type:'ready'}            the page loaded (the plugin answers with a state)
//     {type:'resize', height}   the page measured its content (a multi-line card, the date picker): resize the bar (20-800 px)
// Escape is handled by the host (window.workbarPanel.hide()), not by a message.

export type Mode = 'unconfigured' | 'editing' | 'submitting' | 'success' | 'error';

export interface StateMessage {
  readonly type: 'state';
  readonly mode: Mode;
  readonly column: string;
  readonly dateFormat: string;
  readonly dateTrigger: string;
  /** The IANA zone the due-date chips are computed in. */
  readonly tz: string;
  /** The plugin's clock, so the page's "today" agrees with the success line the plugin builds. */
  readonly nowIso: string;
  readonly message?: string;
}

export type PageMessage = { readonly type: 'submit'; readonly text: string } | { readonly type: 'openSettings' } | { readonly type: 'ready' } | { readonly type: 'resize'; readonly height: number };

/** Validates a message from the page; anything malformed is dropped (null). The page is a separate, less trusted process. */
export function parsePageMessage(m: unknown): PageMessage | null {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.type === 'openSettings') return { type: 'openSettings' };
  if (o.type === 'ready') return { type: 'ready' };
  if (o.type === 'submit' && typeof o.text === 'string' && o.text.length <= 20_000) return { type: 'submit', text: o.text };
  // The host clamps too, but a nonsense height is a bug in the page: drop it rather than silently clamp it.
  if (o.type === 'resize' && typeof o.height === 'number' && Number.isFinite(o.height) && o.height >= 20 && o.height <= 800) return { type: 'resize', height: o.height };
  return null;
}
