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
let listenerBlock: AudioObjectPropertyListenerBlock = { _, _ in
    emit(["event": "devicesChanged"])
    // The target may have been unplugged, or come back with a new id.
    attachActivityListener()
}
var listening = false

// The target's activity: a transition to "playing" is the plugin's play-start
// backstop. The listener is re-attached whenever the target changes or the
// device list does; the address passed to AudioObjectAddPropertyListenerBlock
// must outlive the registration AND the removal, so it lives here.
var targetNameQuery: String?
var targetUid: String?
var activityAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioDevicePropertyScopeOutput,
    mElement: kAudioObjectPropertyElementMain
)
var activityDeviceID: AudioDeviceID?
let activityQueue = DispatchQueue(label: "com.workbar.audiofix.activity")
let activityBlock: AudioObjectPropertyListenerBlock = { objectID, _ in
    // Only playback STARTING (running now) triggers the backstop; a stop does not.
    if manager.isInUse(deviceID: objectID) { emit(["event": "targetActive"]) }
}

func attachActivityListener() {
    detachActivityListener()
    guard let device = try? manager.matchingDevice(nameQuery: targetNameQuery, uid: targetUid) else { return }
    let status = AudioObjectAddPropertyListenerBlock(device.id, &activityAddress, activityQueue, activityBlock)
    guard status == noErr else {
        FileHandle.standardError.write(Data("attaching the activity listener failed (OSStatus \(status))\n".utf8))
        return
    }
    activityDeviceID = device.id
}

func detachActivityListener() {
    guard let id = activityDeviceID else { return }
    AudioObjectRemovePropertyListenerBlock(id, &activityAddress, activityQueue, activityBlock)
    activityDeviceID = nil
}

func watch(nameQuery: String?, uid: String?) -> String? {
    targetNameQuery = nameQuery
    targetUid = uid
    if !listening {
        let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, listenerQueue, listenerBlock)
        guard status == noErr else { return "registering the device listener failed (OSStatus \(status))" }
        listening = true
    }
    // Re-resolves the target even when already watching: the target may have changed.
    attachActivityListener()
    return nil
}

func unwatch() {
    detachActivityListener()
    guard listening else { return }
    AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, listenerQueue, listenerBlock)
    listening = false
}

func repair(id: Int, nameQuery: String?, uid: String?, onlyWhenIdle: Bool) {
    do {
        let device = try manager.matchingDevice(nameQuery: nameQuery, uid: uid)
        if onlyWhenIdle, manager.isInUse(deviceID: device.id) {
            emit(["id": id, "status": "busy"])
            return
        }
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
        if let problem = watch(nameQuery: blank(object["nameQuery"] as? String), uid: blank(object["uid"] as? String)) {
            FileHandle.standardError.write(Data((problem + "\n").utf8))
        }
    case "unwatch":
        unwatch()
    case "repair":
        guard let id else { return }
        work.async { repair(id: id, nameQuery: blank(object["nameQuery"] as? String), uid: blank(object["uid"] as? String), onlyWhenIdle: false) }
    case "repairIfIdle":
        guard let id else { return }
        work.async { repair(id: id, nameQuery: blank(object["nameQuery"] as? String), uid: blank(object["uid"] as? String), onlyWhenIdle: true) }
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
