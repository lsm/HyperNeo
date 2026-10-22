import Foundation

public struct CaptureRequest: Codable {
    public let appBundleId: String
    public let title: String?
    public let windowId: UInt32?
    public let evidenceDir: String
}

public struct CaptureWindow {
    public let id: UInt32
    public let appBundleId: String
    public let title: String
    public init(id: UInt32, appBundleId: String, title: String) {
        self.id = id; self.appBundleId = appBundleId; self.title = title
    }
}

public struct CaptureImage {
    public let png: Data
    public let width: Int
    public let height: Int
    public init(png: Data, width: Int, height: Int) {
        self.png = png; self.width = width; self.height = height
    }
}

public struct CaptureFailure: Error, Codable {
    public let code: String
    public let detail: String
    public init(code: String, detail: String) { self.code = code; self.detail = detail }
}

public struct CaptureRecord: Codable {
    public struct Size: Codable { public let width: Int; public let height: Int }
    public let windowId: UInt32
    public let appBundleId: String
    public let title: String
    public let timestamp: String
    public let size: Size
}

public struct CaptureOutput: Encodable {
    public let ok = true
    public let png: String
    public let record: String
}

@MainActor
public protocol CaptureAPI {
    func hasPermission() -> Bool
    func windows() async throws -> [CaptureWindow]
    func image(for window: CaptureWindow) async throws -> CaptureImage
}

@MainActor
public func capture(_ request: CaptureRequest, api: CaptureAPI) async throws -> CaptureOutput {
    guard !request.appBundleId.isEmpty, !request.evidenceDir.isEmpty,
          (request.title?.isEmpty == false || (request.windowId ?? 0) > 0) else {
        throw CaptureFailure(code: "invalid_request", detail: "Supply appBundleId, exact title or positive windowId, and a fresh evidenceDir.")
    }
    guard api.hasPermission() else {
        throw CaptureFailure(code: "permission_missing", detail: "Existing Screen Recording permission is unavailable. No permission request or capture was attempted.")
    }
    let matches = try await api.windows().filter {
        $0.appBundleId == request.appBundleId &&
        (request.title == nil || $0.title == request.title) &&
        (request.windowId == nil || $0.id == request.windowId)
    }
    guard matches.count == 1 else {
        throw CaptureFailure(code: "window_not_unique", detail: "Expected exactly one window for that app and title/id; found \(matches.count). No image captured.")
    }
    let window = matches[0]
    let image = try await api.image(for: window)
    guard !image.png.isEmpty, image.width > 0, image.height > 0 else {
        throw CaptureFailure(code: "capture_failed", detail: "Capture returned no usable image.")
    }
    let record = CaptureRecord(windowId: window.id, appBundleId: window.appBundleId,
        title: window.title, timestamp: ISO8601DateFormatter().string(from: Date()),
        size: .init(width: image.width, height: image.height))
    let output = URL(fileURLWithPath: request.evidenceDir).standardizedFileURL
    let files = FileManager.default
    let staged = output.deletingLastPathComponent().appendingPathComponent(".capture-\(UUID().uuidString)")
    defer { try? files.removeItem(at: staged) }
    do {
        guard !files.fileExists(atPath: output.path) else {
            throw CaptureFailure(code: "output_failed", detail: "evidenceDir already exists; use a fresh destination. Existing evidence is untouched.")
        }
        try files.createDirectory(at: staged, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try image.png.write(to: staged.appendingPathComponent("window.png"))
        try JSONEncoder().encode(record).write(to: staged.appendingPathComponent("window.json"))
        try files.moveItem(at: staged, to: output)
    } catch {
        throw CaptureFailure(code: "output_failed", detail: "No new capture published: \(error).")
    }
    return CaptureOutput(png: output.appendingPathComponent("window.png").path,
        record: output.appendingPathComponent("window.json").path)
}
