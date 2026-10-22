// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PassiveWindowCapture",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "capture-window", targets: ["CaptureWindow"])],
  targets: [
    .target(name: "WindowCaptureCore"),
    .executableTarget(name: "CaptureWindow", dependencies: ["WindowCaptureCore"]),
    .testTarget(name: "WindowCaptureCoreTests", dependencies: ["WindowCaptureCore"]),
  ]
)
