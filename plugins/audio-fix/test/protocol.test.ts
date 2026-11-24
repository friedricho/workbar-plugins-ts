// The helper protocol: every line shape the plugin must accept, including the
// 2.1.0 additions (busy reply, targetActive event), and the malformed ones it
// must drop.
import { describe, expect, it } from 'vitest';
import { parseHelperMessage } from '../src/protocol.js';

describe('parseHelperMessage', () => {
  it('parses the events', () => {
    expect(parseHelperMessage({ event: 'ready' })).toEqual({ event: 'ready' });
    expect(parseHelperMessage({ event: 'devicesChanged' })).toEqual({ event: 'devicesChanged' });
    expect(parseHelperMessage({ event: 'targetActive' })).toEqual({ event: 'targetActive' });
  });

  it('parses the repair replies', () => {
    expect(parseHelperMessage({ id: 1, status: 'repaired', device: 'DELL S2725QC', format: '2ch 24-bit 48000 Hz (lpcm)' }))
      .toEqual({ id: 1, status: 'repaired', device: 'DELL S2725QC', format: '2ch 24-bit 48000 Hz (lpcm)' });
    expect(parseHelperMessage({ id: 2, status: 'absent', message: 'S2725QC not connected' }))
      .toEqual({ id: 2, status: 'absent', message: 'S2725QC not connected' });
    expect(parseHelperMessage({ id: 3, status: 'busy' })).toEqual({ id: 3, status: 'busy' });
    expect(parseHelperMessage({ id: 4, status: 'failed', message: 'OSStatus 1' }))
      .toEqual({ id: 4, status: 'failed', message: 'OSStatus 1' });
    expect(parseHelperMessage({ id: 5, status: 'listed', devices: [{ name: 'S2725QC', uid: 'AB:1', format: '2ch', writable: true }] }))
      .toEqual({ id: 5, status: 'listed', devices: [{ name: 'S2725QC', uid: 'AB:1', format: '2ch', writable: true }] });
  });

  it('drops malformed lines', () => {
    expect(parseHelperMessage(null)).toBeNull();
    expect(parseHelperMessage('text')).toBeNull();
    expect(parseHelperMessage([1])).toBeNull();
    expect(parseHelperMessage({ id: 1 })).toBeNull(); // no status
    expect(parseHelperMessage({ status: 'busy' })).toBeNull(); // no id
    expect(parseHelperMessage({ id: 1, status: 'repaired', device: 'x' })).toBeNull(); // no format
    expect(parseHelperMessage({ id: 1, status: 'absent' })).toBeNull(); // no message
    expect(parseHelperMessage({ id: 1, status: 'listed', devices: 'nope' })).toBeNull();
    expect(parseHelperMessage({ id: 1, status: 'listed', devices: [{ name: 'x', uid: 'y', format: 'z', writable: 'yes' }] })).toBeNull();
    expect(parseHelperMessage({ id: 1, status: 'unknown' })).toBeNull();
    expect(parseHelperMessage({ event: 'surprise' })).toBeNull();
  });
});
