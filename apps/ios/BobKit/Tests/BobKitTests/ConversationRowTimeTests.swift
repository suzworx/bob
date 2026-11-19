import XCTest
@testable import BobKit

final class ConversationRowTimeTests: XCTestCase {
    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private func text(_ date: Date, now: Date) -> String {
        ConversationRules.rowTime(date, now: now, calendar: calendar, locale: locale)
    }

    func testTodayShowsTheClockTime() {
        let result = text(date(2026, 11, 4, 9, 5), now: date(2026, 11, 4, 18))
        XCTAssertTrue(result.hasPrefix("9:05"), result)
    }

    func testYesterdayIsNamed() {
        XCTAssertEqual(text(date(2026, 11, 3, 23, 50), now: date(2026, 11, 4, 0, 10)), "Yesterday")
    }

    func testThisWeekShowsTheWeekday() {
        XCTAssertEqual(text(date(2026, 11, 1), now: date(2026, 11, 4)), "Sunday")
    }

    func testOlderShowsAShortDate() {
        XCTAssertEqual(text(date(2026, 10, 15), now: date(2026, 11, 4)), "10/15/26")
    }

    func testAFutureTimeFromClockSkewStaysAClockTime() {
        let result = text(date(2026, 11, 4, 18, 1), now: date(2026, 11, 4, 18))
        XCTAssertTrue(result.hasPrefix("6:01"), result)
    }
}

final class ConversationDisplayTitleTests: XCTestCase {
    private func title(_ raw: String) -> String {
        ConversationSummary(id: "c", title: raw, createdAt: Date(), updatedAt: Date(), pinned: false, archived: false).displayTitle
    }

    func testAMentionTokenShowsOnlyItsService() {
        XCTAssertEqual(title("Search my @{integration:Gmail.search:person@example.test} inbox"), "Search my @Gmail inbox")
    }

    func testATokenCutOffByTheTitleLimitStillHidesTheAccount() {
        XCTAssertEqual(title("Search my @{integration:Gmail.search:person@exam"), "Search my @Gmail")
    }

    func testAPlainTitleIsUnchanged() {
        XCTAssertEqual(title(" Week plan "), "Week plan")
    }
}
