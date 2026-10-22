import Foundation
import WindowCaptureCore

@main
struct Main {
    @MainActor
    static func main() async {
        do {
            let request: CaptureRequest
            do {
                request = try JSONDecoder().decode(CaptureRequest.self, from: FileHandle.standardInput.readDataToEndOfFile())
            } catch {
                throw CaptureFailure(code: "invalid_request", detail: "Expected JSON on stdin: appBundleId, title and/or windowId, evidenceDir. \(error)")
            }
            let result = try await capture(request, api: ScreenCapture())
            FileHandle.standardOutput.write(try JSONEncoder().encode(result) + Data("\n".utf8))
        } catch {
            let failure = error as? CaptureFailure ?? CaptureFailure(code: "capture_failed", detail: String(describing: error))
            struct Refusal: Encodable { let ok = false; let code: String; let detail: String }
            let result = Refusal(code: failure.code, detail: failure.detail)
            if let data = try? JSONEncoder().encode(result) {
                FileHandle.standardOutput.write(data + Data("\n".utf8))
            }
            exit(1)
        }
    }
}
