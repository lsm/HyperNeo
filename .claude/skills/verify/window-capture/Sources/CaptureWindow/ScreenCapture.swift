import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import WindowCaptureCore

@MainActor
final class ScreenCapture: CaptureAPI {
    private var catalog: [SCWindow] = []
    func hasPermission() -> Bool { CGPreflightScreenCaptureAccess() }
    func windows() async throws -> [CaptureWindow] {
        catalog = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false).windows
        return catalog.compactMap { window in
            guard let app = window.owningApplication else { return nil }
            return CaptureWindow(id: window.windowID, appBundleId: app.bundleIdentifier, title: window.title ?? "")
        }
    }
    func image(for selected: CaptureWindow) async throws -> CaptureImage {
        guard let window = catalog.first(where: {
            $0.windowID == selected.id && $0.owningApplication?.bundleIdentifier == selected.appBundleId &&
            ($0.title ?? "") == selected.title
        }) else { throw CaptureFailure(code: "capture_failed", detail: "Selected window is no longer available.") }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(ceil(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
        configuration.height = Int(ceil(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw CaptureFailure(code: "capture_failed", detail: "PNG encoder is unavailable.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureFailure(code: "capture_failed", detail: "PNG encoding failed.")
        }
        return CaptureImage(png: data as Data, width: image.width, height: image.height)
    }
}
