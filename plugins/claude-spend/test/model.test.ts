// Ported from ClaudeSpendModelsTests + ClaudeSpendFormattersTests, against the
// four Swift fixtures (byte-exact copies).
import { describe, expect, it } from 'vitest';
import {
  bandFor, creditsDisabled, decodeUsage, DecodeError, disabledReason, displayPercent, encodeUsage, firstStringValue, formatMoney,
  formatPercent, hasSeatWindows, isOverLimit, limitMoney, numbersFor, spendLimitReached, statusLineFor, usedCreditsMinor, usedMoney, utilizationPercent,
  type ClaudeUsageStatus,
} from '../src/model.js';
import { fixture } from './support.js';

const live = () => decodeUsage(fixture('claude-usage-live'));

describe('usage payload decoding', () => {
  it('the live payload decodes with the documented field readings', () => {
    const s = live();
    expect(s.spend.used).toEqual({ amountMinor: 30482, currency: 'USD', exponent: 2 });
    expect(s.spend.limit).toEqual({ amountMinor: 110000, currency: 'USD', exponent: 2 });
    expect(utilizationPercent(s)).toBe(27.71090909090909); // the server's number, not a recomputation
    expect(displayPercent(s)).toBe(28);
    expect(usedMoney(s)).toEqual(s.spend.used);
    expect(limitMoney(s)).toEqual(s.spend.limit);
    expect(s.extraUsage.monthlyLimit).toBe(110000); // minor units despite the bare names
    expect(s.extraUsage.usedCredits).toBe(30482);
    expect(usedCreditsMinor(s)).toBe(30482);
    expect(creditsDisabled(s)).toBe(false);
    expect(spendLimitReached(s)).toBe(false);
    expect(isOverLimit(s)).toBe(false);
    expect(s.spend.severity).toBe('normal');
    expect(hasSeatWindows(s)).toBe(false);
    expect(s.memberDashboardAvailable).toBe(true);
  });

  it('the credits-disabled payload reads as disabled with its reason (numbers still there, never a silent $0)', () => {
    const s = decodeUsage(fixture('claude-usage-credits-disabled'));
    expect(creditsDisabled(s)).toBe(true);
    expect(disabledReason(s)).toBe('Your admin disabled usage credits for this workspace');
    expect(usedMoney(s)).toEqual({ amountMinor: 30482, currency: 'USD', exponent: 2 });
  });

  it('the limit-reached payload reads as over-limit', () => {
    const s = decodeUsage(fixture('claude-usage-limit-reached'));
    expect(spendLimitReached(s)).toBe(true);
    expect(isOverLimit(s)).toBe(true);
    expect(s.spend.severity).toBe('exceeded');
    expect(utilizationPercent(s)).toBe(100);
    expect(creditsDisabled(s)).toBe(false);
  });

  it('a seat-window payload decodes (unknown shape tolerated) and flags presence', () => {
    const s = decodeUsage(fixture('claude-usage-seat-windows'));
    expect(hasSeatWindows(s)).toBe(true);
    expect(creditsDisabled(s)).toBe(true); // credits are effectively off on a seat-allowance org
    expect(s.fiveHour).toMatchObject({ model: 'claude-sonnet-5-5' }); // captured, not lost
    expect(s.limits).toHaveLength(2);
    expect(firstStringValue({ organizations: [{ name: 'Acme', uuid: 'abc-123' }] }, 'uuid')).toBe('abc-123'); // at any depth
  });

  it('fails closed: missing spend/extra_usage or a non-object payload is a decode failure, never zeros', () => {
    for (const bad of ['"hello"', '{"spend": null}', '{"spend": {"used": null, "limit": null}}', '{"extra_usage": {}}', '[]', 'null']) {
      expect(() => decodeUsage(bad), bad).toThrow(DecodeError);
    }
  });

  it('an HTML body fails the decode (Cloudflare pages never render as data)', () => {
    expect(() => decodeUsage('<!DOCTYPE html><html><body>challenge</body></html>')).toThrow(DecodeError);
  });

  it('a wrongly typed field fails the decode (a shape change must not become a silent $0)', () => {
    const base = JSON.parse(fixture('claude-usage-live'));
    base.spend.used.amount_minor = '30482';
    expect(() => decodeUsage(JSON.stringify(base))).toThrow(DecodeError);
    const other = JSON.parse(fixture('claude-usage-live'));
    other.extra_usage.utilization = 'high';
    expect(() => decodeUsage(JSON.stringify(other))).toThrow(DecodeError);
    const partial = JSON.parse(fixture('claude-usage-live'));
    delete partial.spend.used.exponent;
    expect(() => decodeUsage(JSON.stringify(partial))).toThrow(DecodeError);
  });

  it('a missing field inside a present block renders as "—" instead of failing', () => {
    const s = decodeUsage('{"spend": {}, "extra_usage": {"is_enabled": true}}');
    expect(statusLineFor(s)).toBe('Claude credits —');
  });

  it('extra_usage money derivation fills in currency/exponent defaults', () => {
    const s = live();
    const noSpend = decodeUsage(JSON.stringify({ spend: {}, extra_usage: { ...JSON.parse(fixture('claude-usage-live')).extra_usage, currency: undefined, decimal_places: undefined } }));
    expect(usedMoney(noSpend)).toEqual({ amountMinor: 30482, currency: 'USD', exponent: 2 });
    expect(limitMoney(noSpend)).toEqual({ amountMinor: 110000, currency: 'USD', exponent: 2 });
    expect(s.extraUsage.currency).toBe('USD');
  });

  it('the codec round-trips every fixture (snapshot persistence shape)', () => {
    for (const name of ['claude-usage-live', 'claude-usage-credits-disabled', 'claude-usage-limit-reached', 'claude-usage-seat-windows']) {
      const s = decodeUsage(fixture(name));
      expect(decodeUsage(encodeUsage(s))).toEqual(s);
    }
  });
});

describe('formatting', () => {
  it('money formats minor units at the payload’s exponent with grouping', () => {
    expect(formatMoney({ amountMinor: 30482, currency: 'USD', exponent: 2 })).toBe('$304.82');
    expect(formatMoney({ amountMinor: 110000, currency: 'USD', exponent: 2 })).toBe('$1,100.00');
    expect(formatMoney({ amountMinor: 1100, currency: 'USD', exponent: 0 })).toBe('$1,100');
    expect(formatMoney({ amountMinor: 0, currency: 'USD', exponent: 2 })).toBe('$0.00');
    expect(formatMoney({ amountMinor: 110000, currency: 'EUR', exponent: 2 })).toBe('€1,100.00'); // its own symbol
    expect(formatMoney({ amountMinor: 30482, currency: 'USD', exponent: 3 })).toBe('$30.482'); // never a hardcoded /100
  });

  it('percent is an integer, half away from zero', () => {
    expect(formatPercent(27.71090909090909)).toBe('28%');
    expect(formatPercent(27.49)).toBe('27%');
    expect(formatPercent(0.4)).toBe('0%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(0.5)).toBe('1%');
    expect(formatPercent(-0.5)).toBe('-1%'); // away from zero, like Swift's rounded()
  });

  it('band boundaries: green < 70, yellow at 70, red at 90', () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(bandFor)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('the menu line reads exactly as planned', () => {
    expect(statusLineFor(live())).toBe('Claude credits $304.82 / $1,100.00 (28%)');
    expect(numbersFor(live())).toBe('$304.82 of $1,100.00 (28%)');
  });

  it('utilization drives the display percent when spend.percent is absent', () => {
    const s = live();
    const { percent: _dropped, ...spendWithoutPercent } = s.spend;
    const noPercent: ClaudeUsageStatus = { ...s, spend: spendWithoutPercent };
    expect(displayPercent(noPercent)).toBe(28); // round(27.71)
  });
});
