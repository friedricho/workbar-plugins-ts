import CoreAudio
import Foundation

struct AudioFormat: Equatable, CustomStringConvertible {
    let sampleRate: Double
    let channels: UInt32
    let bitsPerChannel: UInt32
    let formatID: AudioFormatID
    let formatFlags: AudioFormatFlags

    init(_ description: AudioStreamBasicDescription) {
        sampleRate = description.mSampleRate
        channels = description.mChannelsPerFrame
        bitsPerChannel = description.mBitsPerChannel
        formatID = description.mFormatID
        formatFlags = description.mFormatFlags
    }

    var description: String {
        let rate = sampleRate.formatted(.number.precision(.fractionLength(0...2)))
        return "\(channels)ch \(bitsPerChannel)-bit \(rate) Hz (\(fourCC(formatID)))"
    }

    // CoreAudio drivers may normalize flags (for example by adding the
    // native-endian bit) after a successful write. Audio MIDI Setup treats
    // those representations as the same PCM format, so verification should
    // compare the user-visible format rather than raw flag equality.
    func matches(_ other: AudioFormat) -> Bool {
        abs(sampleRate - other.sampleRate) < 0.5 &&
        channels == other.channels &&
        bitsPerChannel == other.bitsPerChannel &&
        formatID == other.formatID
    }

    private func fourCC(_ value: AudioFormatID) -> String {
        let bytes = [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff)
        ]
        let text = String(bytes: bytes, encoding: .ascii) ?? "????"
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct AudioDevice: Identifiable {
    let id: AudioDeviceID
    let name: String
    let uid: String
    let currentFormat: AudioFormat?
    let canSetFormat: Bool

    var identity: String {
        uid.isEmpty ? name : "\(name) [\(uid)]"
    }
}

enum AudioFixError: LocalizedError {
    case noDevices
    case noMatch(String)
    case multipleMatches([AudioDevice])
    case noOutputStream(AudioDevice)
    case unsupportedFormat(AudioDevice, String)
    case propertyError(String, OSStatus)
    case verificationFailed(AudioFormat?, AudioFormat)

    var errorDescription: String? {
        switch self {
        case .noDevices:
            return "CoreAudio reported no output devices."
        case .noMatch(let query):
            return "No output device matched \"\(query)\". Confirm the monitor is connected and run --list."
        case .multipleMatches(let devices):
            return "More than one output device matched: \(devices.map(\.identity).joined(separator: ", ")). Use --uid to select one."
        case .noOutputStream(let device):
            return "\(device.identity) has no writable output stream."
        case .unsupportedFormat(let device, let detail):
            return "\(device.identity) does not expose the requested 48 kHz, 2-channel, 24-bit format. \(detail)"
        case .propertyError(let operation, let status):
            return "CoreAudio failed while \(operation) (OSStatus \(status))."
        case .verificationFailed(let actual, let expected):
            return "The format write did not stick. Expected \(expected), but CoreAudio reports \(actual?.description ?? "no format")."
        }
    }
}

final class CoreAudioDeviceManager {
    static let resetFormat = AudioFormat(
        sampleRate: 48_000,
        channels: 2,
        bitsPerChannel: 16,
        formatID: kAudioFormatLinearPCM,
        formatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
    )

    static let desiredFormat = AudioFormat(
        sampleRate: 48_000,
        channels: 2,
        bitsPerChannel: 24,
        formatID: kAudioFormatLinearPCM,
        formatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
    )

    private static let toggleDelay: TimeInterval = 0.35

    func outputDevices() throws -> [AudioDevice] {
        let deviceIDs = try allDeviceIDs()
        return try deviceIDs.compactMap { deviceID in
            guard hasOutputChannels(deviceID) else { return nil }
            let name = try stringProperty(deviceID, selector: kAudioObjectPropertyName)
            let uid = (try? stringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID)) ?? ""
            let stream = try? outputStream(deviceID)
            let current = stream.flatMap { try? currentFormat(deviceID: deviceID, streamID: $0) }
            let writable = stream.map { canSetFormat(deviceID: deviceID, streamID: $0) } ?? false
            return AudioDevice(id: deviceID, name: name, uid: uid, currentFormat: current, canSetFormat: writable)
        }
    }

    func matchingDevice(nameQuery: String?, uid: String?) throws -> AudioDevice {
        let devices = try outputDevices()
        if devices.isEmpty { throw AudioFixError.noDevices }

        if let uid {
            guard let device = devices.first(where: { $0.uid == uid }) else {
                throw AudioFixError.noMatch(uid)
            }
            return device
        }

        let query = nameQuery ?? "S2725QC"
        let matches = devices.filter { $0.name.localizedCaseInsensitiveContains(query) }
        guard !matches.isEmpty else { throw AudioFixError.noMatch(query) }
        guard matches.count == 1 else { throw AudioFixError.multipleMatches(matches) }
        return matches[0]
    }

    func repair(device: AudioDevice, dryRun: Bool) throws -> AudioFormat {
        guard let streamID = try? outputStream(device.id) else {
            throw AudioFixError.noOutputStream(device)
        }

        let current = try currentFormat(deviceID: device.id, streamID: streamID)
        guard canSetFormat(deviceID: device.id, streamID: streamID) else {
            let supported = supportedFormats(deviceID: device.id, streamID: streamID)
            throw AudioFixError.unsupportedFormat(device, "Current format: \(current). Supported formats: \(supported).")
        }
        guard supportsFormat(Self.resetFormat, deviceID: device.id, streamID: streamID) else {
            let supported = supportedFormats(deviceID: device.id, streamID: streamID)
            throw AudioFixError.unsupportedFormat(device, "The reset step requires 16-bit PCM. Supported formats: \(supported).")
        }
        guard supportsFormat(Self.desiredFormat, deviceID: device.id, streamID: streamID) else {
            let supported = supportedFormats(deviceID: device.id, streamID: streamID)
            throw AudioFixError.unsupportedFormat(device, "Supported formats: \(supported).")
        }
        if dryRun { return current }

        // Always perform the same transition as Audio MIDI Setup, even when
        // CoreAudio already reports 24-bit. The intermediate format change
        // resets monitor drivers that have become stuck after reconnecting.
        try setFormat(deviceID: device.id, streamID: streamID, format: Self.resetFormat)
        _ = try waitForFormat(Self.resetFormat, deviceID: device.id, streamID: streamID)
        Thread.sleep(forTimeInterval: Self.toggleDelay)
        try setFormat(deviceID: device.id, streamID: streamID, format: Self.desiredFormat)
        let actual = try waitForFormat(Self.desiredFormat, deviceID: device.id, streamID: streamID)
        return actual
    }

    private func allDeviceIDs() throws -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
        guard status == noErr else { throw AudioFixError.propertyError("enumerating device size", status) }
        var devices = Array(repeating: AudioDeviceID(0), count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices)
        guard status == noErr else { throw AudioFixError.propertyError("enumerating devices", status) }
        return devices
    }

    private func hasOutputChannels(_ deviceID: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr else { return false }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, raw) == noErr else { return false }
        let list = raw.assumingMemoryBound(to: AudioBufferList.self).pointee
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: raw.assumingMemoryBound(to: AudioBufferList.self)))
        _ = list
        return buffers.reduce(0) { $0 + Int($1.mNumberChannels) } > 0
    }

    private func outputStream(_ deviceID: AudioDeviceID) throws -> AudioStreamID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
        guard status == noErr else { throw AudioFixError.propertyError("reading output streams", status) }
        var streams = Array(repeating: AudioStreamID(0), count: Int(size) / MemoryLayout<AudioStreamID>.size)
        status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &streams)
        guard status == noErr, let stream = streams.first else {
            throw AudioFixError.noOutputStream(AudioDevice(id: deviceID, name: "device", uid: "", currentFormat: nil, canSetFormat: false))
        }
        return stream
    }

    private func currentFormat(deviceID: AudioDeviceID, streamID: AudioStreamID) throws -> AudioFormat {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyPhysicalFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(streamID, &address, 0, nil, &size, &format)
        guard status == noErr else { throw AudioFixError.propertyError("reading the current format", status) }
        _ = deviceID
        return AudioFormat(format)
    }

    private func supportedFormats(deviceID: AudioDeviceID, streamID: AudioStreamID) -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyAvailablePhysicalFormats,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(streamID, &address, 0, nil, &size) == noErr else { return "unavailable" }
        var formats = Array(repeating: AudioStreamRangedDescription(), count: Int(size) / MemoryLayout<AudioStreamRangedDescription>.size)
        guard AudioObjectGetPropertyData(streamID, &address, 0, nil, &size, &formats) == noErr else { return "unavailable" }
        _ = deviceID
        return formats.map { "\(AudioFormat($0.mFormat)) [\($0.mSampleRateRange.mMinimum)-\($0.mSampleRateRange.mMaximum) Hz]" }.joined(separator: "; ")
    }

    private func waitForFormat(_ expected: AudioFormat, deviceID: AudioDeviceID, streamID: AudioStreamID) throws -> AudioFormat {
        for _ in 0..<20 {
            let actual = try currentFormat(deviceID: deviceID, streamID: streamID)
            if actual.matches(expected) { return actual }
            Thread.sleep(forTimeInterval: 0.05)
        }
        let actual = try? currentFormat(deviceID: deviceID, streamID: streamID)
        throw AudioFixError.verificationFailed(actual, expected)
    }

    private func supportsFormat(_ format: AudioFormat, deviceID: AudioDeviceID, streamID: AudioStreamID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyAvailablePhysicalFormats,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(streamID, &address, 0, nil, &size) == noErr else { return false }
        var formats = Array(repeating: AudioStreamRangedDescription(), count: Int(size) / MemoryLayout<AudioStreamRangedDescription>.size)
        guard AudioObjectGetPropertyData(streamID, &address, 0, nil, &size, &formats) == noErr else { return false }
        _ = deviceID
        return formats.contains {
            $0.mFormat.mFormatID == format.formatID &&
            $0.mFormat.mChannelsPerFrame == format.channels &&
            $0.mFormat.mBitsPerChannel == format.bitsPerChannel &&
            $0.mSampleRateRange.mMinimum <= format.sampleRate &&
            $0.mSampleRateRange.mMaximum >= format.sampleRate
        }
    }

    private func canSetFormat(deviceID: AudioDeviceID, streamID: AudioStreamID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyPhysicalFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var isSettable: DarwinBoolean = false
        let status = AudioObjectIsPropertySettable(streamID, &address, &isSettable)
        _ = deviceID
        return status == noErr && isSettable.boolValue
    }

    private func setFormat(deviceID: AudioDeviceID, streamID: AudioStreamID, format: AudioFormat) throws {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioStreamPropertyPhysicalFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var description = AudioStreamBasicDescription(
            mSampleRate: format.sampleRate,
            mFormatID: format.formatID,
            mFormatFlags: format.formatFlags,
            mBytesPerPacket: format.channels * format.bitsPerChannel / 8,
            mFramesPerPacket: 1,
            mBytesPerFrame: format.channels * format.bitsPerChannel / 8,
            mChannelsPerFrame: format.channels,
            mBitsPerChannel: format.bitsPerChannel,
            mReserved: 0
        )
        let size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectSetPropertyData(streamID, &address, 0, nil, size, &description)
        guard status == noErr else { throw AudioFixError.propertyError("setting the requested format", status) }
        _ = deviceID
    }

    private func stringProperty(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let value else { throw AudioFixError.propertyError("reading a device property", status) }
        return value.takeUnretainedValue() as String
    }
}

private extension AudioFormat {
    init(sampleRate: Double, channels: UInt32, bitsPerChannel: UInt32, formatID: AudioFormatID, formatFlags: AudioFormatFlags) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitsPerChannel = bitsPerChannel
        self.formatID = formatID
        self.formatFlags = formatFlags
    }
}
