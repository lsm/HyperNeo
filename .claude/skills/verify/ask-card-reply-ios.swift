import XCTest

@MainActor
final class AskReplyEvidenceTests: XCTestCase {
    func testAskMenuQuotesItsTitleInTheComposer() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoMode", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Your work")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 15))
        work.tap()
        let actions = app.buttons["Actions for Draft the iOS API client"]
        XCTAssertTrue(actions.waitForExistence(timeout: 8))
        actions.tap()
        XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 5))
        shot("ios-ask-menu", app)
        app.buttons["Reply"].tap()
        XCTAssertTrue(app.staticTexts["Draft the iOS API client"].waitForExistence(timeout: 8))
        if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
        shot("ios-ask-composer", app)
        app.terminate()
    }
    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
