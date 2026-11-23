// swift-tools-version:5.9
import PackageDescription

// audiofix-helper: the CoreAudio half of the Audio Fix plugin. Build a
// universal binary with  swift build -c release --arch arm64 --arch x86_64
// (tools/build-helpers.mjs does this and copies it to ../bin/).
let package = Package(
    name: "audiofix-helper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "audiofix-helper", path: "Sources/audiofix-helper"),
    ]
)
