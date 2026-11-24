// The page is a separate, less trusted process: everything it sends is validated.
import { describe, expect, it } from 'vitest';
import { parsePageMessage } from '../src/protocol.js';

describe('parsePageMessage', () => {
  it('accepts the three messages the page may send', () => {
    expect(parsePageMessage({ type: 'submit', text: 'hi' })).toEqual({ type: 'submit', text: 'hi' });
    expect(parsePageMessage({ type: 'openSettings' })).toEqual({ type: 'openSettings' });
    expect(parsePageMessage({ type: 'ready' })).toEqual({ type: 'ready' });
  });
  it('accepts a resize request with a sane height, and drops anything else', () => {
    expect(parsePageMessage({ type: 'resize', height: 46 })).toEqual({ type: 'resize', height: 46 });
    expect(parsePageMessage({ type: 'resize', height: 800 })).toEqual({ type: 'resize', height: 800 });
    expect(parsePageMessage({ type: 'resize', height: 20 })).toEqual({ type: 'resize', height: 20 });
    for (const h of [19.9, 800.1, -5, 0, NaN, Infinity, '46', null, undefined]) expect(parsePageMessage({ type: 'resize', height: h }), String(h)).toBeNull();
    expect(parsePageMessage({ type: 'resize' })).toBeNull();
  });
  it('drops anything else, including extra fields on a valid type (they are not passed on)', () => {
    for (const bad of [null, undefined, 'x', 5, true, [], {}, { type: 'submit' }, { type: 'submit', text: 5 }, { type: 'submit', text: null }, { type: 'nope' }, { text: 'x' }]) {
      expect(parsePageMessage(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parsePageMessage({ type: 'openSettings', path: '/etc/passwd' })).toEqual({ type: 'openSettings' });
    expect(parsePageMessage({ type: 'submit', text: 'a', column: 'Done' })).toEqual({ type: 'submit', text: 'a' });
  });
  it('caps a card at 20,000 characters', () => {
    expect(parsePageMessage({ type: 'submit', text: 'x'.repeat(20_000) })).not.toBeNull();
    expect(parsePageMessage({ type: 'submit', text: 'x'.repeat(20_001) })).toBeNull();
  });
  it('multi-line and unicode text passes through untouched', () => {
    const text = 'one\ntwo ✨ 👩‍💻\r\nthree';
    expect(parsePageMessage({ type: 'submit', text })).toEqual({ type: 'submit', text });
  });
});
