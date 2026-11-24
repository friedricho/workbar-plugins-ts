import CoreAudio
import Foundation

// JSON lines on stdin/stdout (see ../../../src/protocol.ts). The helper owns
// only what needs CoreAudio: the device-list listener and the format
// transition. When to repair (settling, the recency guard, retries) is the
// plugin's job. A repair blocks (the transition sleeps), so commands run on a
// private serial queue, never the thread that reads stdin.

let manager = CoreAudioDeviceManager()
let work = DispatchQueue(label: "com.workbar.audiofix.helper")
let outLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    outLock.lock(); defer { outLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

// The listener callback runs on a HAL-owned thread: it only reports the change.
var devicesAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
let listenerQueue = DispatchQueue(label: "com.workbar.audiofix.listener")
let listenerBlock: AudioObjectPropertyListenerBlock = { _, _ in emit(["event": "devicesChanged"]) }
var listening = false

func watch() -> String? {
    if listening { return nil }
    let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, listenerQueue, listenerBlock)
    guard status == noErr else { return "registering the device listener failed (OSStatus \(status))" }
    listening = true
    return nil
}

func unwatch() {
    guard listening else { return }
    AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, listenerQueue, listenerBlock)
    listening = false
}

func repair(id: Int, nameQuery: String?, uid: String?) {
    do {
        let device = try manager.matchingDevice(nameQuery: nameQuery, uid: uid)
        let result = try manager.repair(device: device, dryRun: false)
        emit(["id": id, "status": "repaired", "device": device.identity, "format": result.description])
    } catch AudioFixError.noMatch, AudioFixError.noDevices {
        // The monitor simply isn't connected: not an error.
        emit(["id": id, "status": "absent", "message": "\(uid ?? nameQuery ?? "target device") not connected"])
    } catch {
        emit(["id": id, "status": "failed", "message": error.localizedDescription])
    }
}

func list(id: Int) {
    do {
        let devices = try manager.outputDevices().map { d -> [String: Any] in
            ["name": d.name, "uid": d.uid, "format": d.currentFormat?.description ?? "unknown", "writable": d.canSetFormat]
        }
        emit(["id": id, "status": "listed", "devices": devices])
    } catch {
        emit(["id": id, "status": "failed", "message": error.localizedDescription])
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = object["cmd"] as? String else { return }
    let id = object["id"] as? Int
    func blank(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }
    switch cmd {
    case "watch":
        if let problem = watch() { FileHandle.standardError.write(Data((problem + "\n").utf8)) }
    case "unwatch":
        unwatch()
    case "repair":
        guard let id else { return }
        work.async { repair(id: id, nameQuery: blank(object["nameQuery"] as? String), uid: blank(object["uid"] as? String)) }
    case "list":
        guard let id else { return }
        work.async { list(id: id) }
    default:
        break
    }
}

emit(["event": "ready"])
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    handle(line)
}
// stdin closed: the host stopped us. Finish any repair in flight, then leave.
work.sync {}
unwatch()
