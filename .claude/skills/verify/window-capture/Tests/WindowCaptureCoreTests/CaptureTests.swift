import Foundation
import XCTest
@testable import WindowCaptureCore

@MainActor
final class FakeCapture: CaptureAPI {
    var permission = true
    var catalog = [CaptureWindow(id: 7, appBundleId: "com.anthropic.claudefordesktop", title: "Synthetic session")]
    var calls: [String] = []
    var fails = false
    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")!
    func hasPermission() -> Bool { calls.append("permission"); return permission }
    func windows() async throws -> [CaptureWindow] { calls.append("windows"); return catalog }
    func image(for window: CaptureWindow) async throws -> CaptureImage {
        calls.append("capture:\(window.id)")
        if fails { throw CaptureFailure(code: "capture_failed", detail: "synthetic capture failure") }
        return CaptureImage(png: png, width: 1, height: 1)
    }
}

final class CaptureTests: XCTestCase {
    @MainActor
    func fixture() throws -> (URL, CaptureRequest, FakeCapture) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (root, CaptureRequest(appBundleId: "com.anthropic.claudefordesktop", title: "Synthetic session", windowId: nil, evidenceDir: root.appendingPathComponent("evidence").path), FakeCapture())
    }

    @MainActor
    func testWritesOnlySelectedWindowWithMatchingRecord() async throws {
        let (root, request, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        api.catalog.append(CaptureWindow(id: 8, appBundleId: "another.app", title: request.title!))
        let result = try await capture(request, api: api)
        let png = URL(fileURLWithPath: result.png)
        let record = try JSONDecoder().decode(CaptureRecord.self, from: Data(contentsOf: URL(fileURLWithPath: result.record)))
        XCTAssertEqual(try Data(contentsOf: png), api.png)
        XCTAssertEqual(record.windowId, 7)
        XCTAssertEqual(record.title, "Synthetic session")
        XCTAssertEqual(record.appBundleId, request.appBundleId)
        XCTAssertEqual(record.size.width, 1)
        XCTAssertEqual(record.size.height, 1)
        XCTAssertNotNil(ISO8601DateFormatter().date(from: record.timestamp))
        XCTAssertEqual(api.calls, ["permission", "windows", "capture:7"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: request.evidenceDir).sorted(), ["window.json", "window.png"])
    }

    @MainActor
    func testMissingPermissionNeverListsOrCaptures() async throws {
        let (root, request, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        api.permission = false
        do { _ = try await capture(request, api: api); XCTFail("must refuse") }
        catch let failure as CaptureFailure { XCTAssertEqual(failure.code, "permission_missing") }
        XCTAssertEqual(api.calls, ["permission"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    @MainActor
    func testMissingOrAmbiguousWindowProducesNoImage() async throws {
        for count in [0, 2] {
            let (root, request, api) = try fixture()
            defer { try? FileManager.default.removeItem(at: root) }
            api.catalog = Array(repeating: api.catalog[0], count: count)
            do { _ = try await capture(request, api: api); XCTFail("must refuse") }
            catch let failure as CaptureFailure { XCTAssertEqual(failure.code, "window_not_unique") }
            XCTAssertEqual(api.calls, ["permission", "windows"])
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        }
    }

    @MainActor
    func testIdAndOwnerAndOptionalTitleMustAllMatch() async throws {
        for field in ["owner", "title", "id"] {
            let (root, original, api) = try fixture()
            defer { try? FileManager.default.removeItem(at: root) }
            let request = CaptureRequest(appBundleId: field == "owner" ? "other.app" : original.appBundleId,
                title: field == "title" ? "Other session" : nil, windowId: field == "id" ? 8 : 7, evidenceDir: original.evidenceDir)
            do { _ = try await capture(request, api: api); XCTFail("must refuse") }
            catch let failure as CaptureFailure { XCTAssertEqual(failure.code, "window_not_unique") }
            XCTAssertFalse(api.calls.contains("capture:7"))
            XCTAssertFalse(FileManager.default.fileExists(atPath: request.evidenceDir))
        }
        let (root, original, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let request = CaptureRequest(appBundleId: original.appBundleId, title: nil, windowId: 7, evidenceDir: original.evidenceDir)
        _ = try await capture(request, api: api)
        XCTAssertEqual(api.calls.last, "capture:7")
    }

    @MainActor
    func testCaptureFailureLeavesNoImageOrMetadata() async throws {
        let (root, request, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        api.fails = true
        do { _ = try await capture(request, api: api); XCTFail("must refuse") }
        catch let failure as CaptureFailure { XCTAssertEqual(failure.code, "capture_failed") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    @MainActor
    func testMissingWindowIdentityNeverCaptures() async throws {
        let (root, original, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let request = CaptureRequest(appBundleId: original.appBundleId, title: nil, windowId: nil, evidenceDir: original.evidenceDir)
        do { _ = try await capture(request, api: api); XCTFail("must refuse") }
        catch let failure as CaptureFailure { XCTAssertEqual(failure.code, "invalid_request") }
        XCTAssertEqual(api.calls, [])
    }

    @MainActor
    func testOutputFailureDoesNotLeaveAnImage() async throws {
        let (root, original, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let blocker = root.appendingPathComponent("regular-file")
        try Data("keep me".utf8).write(to: blocker)
        let request = CaptureRequest(appBundleId: original.appBundleId, title: original.title, windowId: nil, evidenceDir: blocker.appendingPathComponent("evidence").path)
        do { _ = try await capture(request, api: api); XCTFail("must refuse") }
        catch { XCTAssertEqual(try Data(contentsOf: blocker), Data("keep me".utf8)) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["regular-file"])
    }

    @MainActor
    func testExistingEvidenceIsNeverOverwritten() async throws {
        let (root, request, api) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(atPath: request.evidenceDir, withIntermediateDirectories: true)
        let old = URL(fileURLWithPath: request.evidenceDir).appendingPathComponent("window.png")
        try Data("old evidence".utf8).write(to: old)
        do { _ = try await capture(request, api: api); XCTFail("must refuse") }
        catch { XCTAssertEqual(try Data(contentsOf: old), Data("old evidence".utf8)) }
    }
}
