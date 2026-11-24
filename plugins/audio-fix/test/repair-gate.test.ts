// Ported case for case from RepairGateTests.swift (times in seconds there,
// milliseconds here).
import { describe, expect, it } from 'vitest';
import { RepairGate } from '../src/repair-gate.js';

const s = (n: number) => n * 1000;

describe('RepairGate', () => {
  it('first repair is always allowed', () => {
    expect(new RepairGate().canRepair(0)).toBe(true);
  });

  it('recency guard blocks repairs inside the interval', () => {
    const gate = new RepairGate(10);
    gate.recordRepair(s(100));
    expect(gate.canRepair(s(100) + 9_900)).toBe(false); // inside the interval
    expect(gate.canRepair(s(110))).toBe(true);          // exactly at the interval
    expect(gate.canRepair(s(160))).toBe(true);
  });

  it('recording a repair resets the guard window', () => {
    const gate = new RepairGate(10);
    gate.recordRepair(s(100));
    expect(gate.canRepair(s(105))).toBe(false);
    gate.recordRepair(s(200));
    expect(gate.canRepair(s(205))).toBe(false);
    expect(gate.canRepair(s(210))).toBe(true);
  });

  it('backoff schedule matches the old agent’s (2s then 5s)', () => {
    const gate = new RepairGate();
    expect(gate.backoffSeconds(1)).toBe(2);
    expect(gate.backoffSeconds(2)).toBe(5);
  });

  it('max attempts default is three, then give up', () => {
    expect(new RepairGate().maxAttempts).toBe(3);
    expect(new RepairGate(10, 5).maxAttempts).toBe(5);
  });
});
