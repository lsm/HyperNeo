import SwiftUI
import Testing
import UIKit
import WebKit
@testable import Neo

@MainActor
@Suite("Registered bundle WKWebView proof", .serialized)
struct BundlePreviewProof {
    static let source = Data(base64Encoded: "__SOURCE_BASE64__")!
    static let document = String(data: Data(base64Encoded: "__DOCUMENT_BASE64__")!, encoding: .utf8)!

    @Test(arguments: ["en", "zh-Hans"], [320, 402])
    func savedBundleRendersCapturedStylesAndRaster(language: String, width: Int) async throws {
        await HostedWindow.acquire()
        defer { HostedWindow.release() }
        let rig = AppRig()
        rig.daemon.languageSetting = language
        try await rig.open()
        let ref = ArtifactRef(daemonId: ArtifactPreviewTests.daemon, artifactId: "saved-bundle",
            title: "Bundled report", kind: .html, byteLength: Self.source.count)
        rig.daemon.artifactFiles[ref.id] = .init(ref: ref, bytes: Self.source,
            html: Self.document, scriptsRemoved: true)
        let host = UIHostingController(rootView: ArtifactPreviewSheet(ref: ref).environment(rig.store)
            .environment(\.locale, Locale(identifier: language)).preferredColorScheme(.light))
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 1000)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(3))
        let web = try #require(findWeb(in: host.view))
        #expect(!web.configuration.websiteDataStore.isPersistent)
        #expect(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        let snapshot = try await web.takeSnapshot(configuration: nil)
        let words = try ArtifactHTMLTests.capture(host.view, name: "bundle-\(language)-\(width)")
        #expect(words.contains("Bundled report") && words.contains("End of bundled report"))
        #expect(!words.contains("Unlisted") && !words.contains("doctype"))
        let colors = try colorCounts(snapshot)
        #expect(colors.green > 30, "Captured stylesheet changes the visible title color: \(colors)")
        #expect(colors.orange > 1000, "Captured raster pixels are visible: \(colors)")
    }

    private func findWeb(in view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.lazy.compactMap { findWeb(in: $0) }.first
    }

    private func colorCounts(_ image: UIImage) throws -> (green: Int, orange: Int) {
        let cg = try #require(image.cgImage)
        let width = cg.width, height = cg.height
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        try rgba.withUnsafeMutableBytes { buffer in
            let context = try #require(CGContext(data: buffer.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var green = 0, orange = 0
        for at in stride(from: 0, to: rgba.count, by: 4) {
            let r = Int(rgba[at]), g = Int(rgba[at + 1]), b = Int(rgba[at + 2])
            if abs(r - 19) < 6 && abs(g - 113) < 6 && abs(b - 61) < 6 { green += 1 }
            if r > 200 && g > 100 && g < 180 && b < 100 { orange += 1 }
        }
        return (green, orange)
    }
}
