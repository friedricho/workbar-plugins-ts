// JSON lines between the plugin and audiofix-helper (Swift, CoreAudio).
//
// plugin → helper
//   {"cmd":"watch","nameQuery"?:s,"uid"?:s}   start the listeners (device list +
//                                              the target's activity when present)
//   {"cmd":"unwatch"}                          stop them
//   {"cmd":"repair","id":N,"nameQuery"?:s,"uid"?:s}
//   {"cmd":"repairIfIdle","id":N,"nameQuery"?:s,"uid"?:s}   repair unless the
//                                              target is playing (then "busy")
//   {"cmd":"list","id":N}
// helper → plugin
//   {"event":"ready"}
//   {"event":"devicesChanged"}            the device list changed
//   {"event":"targetActive"}             playback started on the target device
//   {"id":N,"status":"repaired","device":s,"format":s}
//   {"id":N,"status":"absent","message":s}   target not connected (not an error)
//   {"id":N,"status":"busy"}                 target in use; not repaired
//   {"id":N,"status":"failed","message":s}
//   {"id":N,"status":"listed","devices":[{"name","uid","format","writable"}]}

export type RepairResult =
  | { readonly status: 'repaired'; readonly device: string; readonly format: string }
  | { readonly status: 'absent'; readonly message: string }
  | { readonly status: 'busy' }
  | { readonly status: 'failed'; readonly message: string };

export interface ListedDevice { readonly name: string; readonly uid: string; readonly format: string; readonly writable: boolean }

export type HelperReply =
  | ({ readonly id: number } & RepairResult)
  | { readonly id: number; readonly status: 'listed'; readonly devices: readonly ListedDevice[] };

export type HelperEvent =
  | { readonly event: 'ready' }
  | { readonly event: 'devicesChanged' }
  | { readonly event: 'targetActive' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a helper line; anything malformed is dropped (null). */
export function parseHelperMessage(m: unknown): HelperReply | HelperEvent | null {
  if (!isObj(m)) return null;
  if (m.event === 'ready' || m.event === 'devicesChanged' || m.event === 'targetActive') return { event: m.event };
  if (typeof m.id !== 'number') return null;
  const id = m.id;
  switch (m.status) {
    case 'repaired':
      return typeof m.device === 'string' && typeof m.format === 'string' ? { id, status: 'repaired', device: m.device, format: m.format } : null;
    case 'busy':
      return { id, status: 'busy' };
    case 'absent': case 'failed':
      return typeof m.message === 'string' ? { id, status: m.status, message: m.message } : null;
    case 'listed': {
      if (!Array.isArray(m.devices)) return null;
      const devices: ListedDevice[] = [];
      for (const d of m.devices) {
        if (!isObj(d) || typeof d.name !== 'string' || typeof d.uid !== 'string' || typeof d.format !== 'string' || typeof d.writable !== 'boolean') return null;
        devices.push({ name: d.name, uid: d.uid, format: d.format, writable: d.writable });
      }
      return { id, status: 'listed', devices };
    }
    default: return null;
  }
}
