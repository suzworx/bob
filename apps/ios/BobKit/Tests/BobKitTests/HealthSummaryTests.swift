import XCTest
@testable import BobKit

final class HealthSummaryTests: XCTestCase {
    private var window: HealthReadWindow {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return HealthReadWindow(days: 1, now: Date(timeIntervalSince1970: 1_700_000_000), calendar: calendar)
    }

    func testDraftRequiresSelectionAndNeverIncludesUnselectedOrUnavailableData() {
        let rows = [HealthSummary(id: "steps", title: "Steps", detail: "1,234 count", hasData: true),
                    HealthSummary(id: "sleep", title: "Sleep", detail: "Private", hasData: true),
                    HealthSummary(id: "heart", title: "Heart", detail: "No readable data", hasData: false)]
        XCTAssertNil(HealthShareDraft.make(rows: rows, selected: [], window: window))
        let draft = HealthShareDraft.make(rows: rows, selected: ["steps", "heart"], window: window)
        XCTAssertTrue(draft?.contains("1,234 count") == true)
        XCTAssertFalse(draft?.contains("Private") == true)
        XCTAssertFalse(draft?.contains("No readable data") == true)
    }

    func testDraftIsBoundedAndRejectsOversizeSelectionWithoutSilentTruncation() {
        let rows = (0..<31).map { HealthSummary(id: "\($0)", title: "Reading", detail: "123", hasData: true) }
        XCTAssertNil(HealthShareDraft.make(rows: rows, selected: Set(rows.map(\.id)), window: window))
    }

    func testDraftPreservesAbsoluteReadWindowForLaterSending() throws {
        let rows = [HealthSummary(id: "steps", title: "Steps", detail: "123 count", hasData: true)]
        let draft = try XCTUnwrap(HealthShareDraft.make(rows: rows, selected: ["steps"], window: window))
        XCTAssertTrue(draft.contains("2023-11-14T00:00:00Z"))
        XCTAssertTrue(draft.contains("2023-11-14T22:13:20Z"))
        XCTAssertTrue(draft.contains("GMT"))
        XCTAssertFalse(draft.contains("Today"))
    }

    func testDurationClipsAndMergesOverlappingSourcesWithoutDoubleCounting() {
        let start = window.start
        let intervals = [
            DateInterval(start: start.addingTimeInterval(-60), end: start.addingTimeInterval(60)),
            DateInterval(start: start.addingTimeInterval(30), end: start.addingTimeInterval(90)),
            DateInterval(start: start.addingTimeInterval(120), end: start.addingTimeInterval(180)),
            DateInterval(start: window.end.addingTimeInterval(60), duration: 30)
        ]
        XCTAssertEqual(window.mergedDuration(intervals), 150)
        XCTAssertEqual(window.mergedDuration([]), 0)
    }

    func testWindowUsesCalendarDaysAndClipsSamplesAcrossBoundary() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date(timeIntervalSince1970: 1_730_635_200)
        let window = HealthReadWindow(days: 7, now: now, calendar: calendar)
        XCTAssertEqual(window.end, now)
        XCTAssertEqual(window.clippedDuration(start: window.start.addingTimeInterval(-60), end: window.start.addingTimeInterval(60)), 60)
        XCTAssertEqual(window.clippedDuration(start: now.addingTimeInterval(1), end: now.addingTimeInterval(100)), 0)
    }
}
