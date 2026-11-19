import XCTest
@testable import BobKit

final class TodayModelTests: XCTestCase {
    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    // October 2026, UTC; the 18th is a Sunday.
    private func date(_ day: Int, _ hour: Int = 0, _ minute: Int = 0) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute)))
    }

    private func item(_ id: String, _ start: Date?, allDay: Bool = false, location: String? = nil, body: String? = nil) -> AgendaItem {
        AgendaItem(eventID: id, title: "Event \(id)", location: location, body: body, isAllDay: allDay, startAt: start)
    }

    func testRecurringOccurrencesHaveDistinctRowIdentities() throws {
        let first = AgendaItem(eventID: "series", title: "Walk", startAt: try date(19, 9), originalOccurrenceStart: 101, spaceID: "family")
        let second = AgendaItem(eventID: "series", title: "Walk", startAt: try date(20, 9), originalOccurrenceStart: 102, spaceID: "family")
        let plan = TodayPlan.make(items: [first, second], now: try date(18), calendar: calendar, locale: locale)
        XCTAssertEqual(Set(plan.thisWeek.map(\.id)).count, 2, "Each occurrence must remain independently navigable")
        XCTAssertEqual(plan.thisWeek.map(\.target), [CalendarEventTarget(item: first), CalendarEventTarget(item: second)])
    }

    func testGreetingBoundaries() {
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 0), "Good morning.")
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 11), "Good morning.")
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 12), "Good afternoon.")
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 16), "Good afternoon.")
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 17), "Good evening.")
        XCTAssertEqual(TodayGreeting.text(name: nil, hour: 23), "Good evening.")
    }

    func testGreetingNameTrimming() {
        XCTAssertEqual(TodayGreeting.text(name: "  Alex \n", hour: 9), "Good morning, Alex.")
        XCTAssertEqual(TodayGreeting.text(name: "   ", hour: 9), "Good morning.")
        XCTAssertEqual(TodayGreeting.text(name: "", hour: 18), "Good evening.")
    }

    func testDayLine() throws {
        XCTAssertEqual(TodayDateText.dayLine(for: try date(18, 9), calendar: calendar, locale: locale), "Sunday, October 18")
    }

    func testRowBuilding() throws {
        let timed = TodayRow.make(from: item("a", try date(18, 10, 30), location: "12 High St", body: "Bring card"), calendar: calendar, locale: locale)
        XCTAssertEqual(timed, TodayRow(id: "a", title: "Event a", subline: "12 High St", timeText: "10:30 AM", isAllDay: false, startAt: try date(18, 10, 30), target: CalendarEventTarget(item: item("a", try date(18, 10, 30)))))
        let allDay = TodayRow.make(from: item("b", try date(18), allDay: true, body: "\n  \n  Pack bags  \nsecond"), calendar: calendar, locale: locale)
        XCTAssertEqual(allDay, TodayRow(id: "b", title: "Event b", subline: "Pack bags", timeText: "All day", isAllDay: true, startAt: try date(18), target: CalendarEventTarget(item: item("b", try date(18), allDay: true))))
        let bare = TodayRow.make(from: item("c", try date(18, 14), location: "  ", body: " \n "), calendar: calendar, locale: locale)
        XCTAssertNil(bare.subline)
        XCTAssertEqual(bare.timeText, "2:00 PM")
        let long = TodayRow.make(from: item("d", try date(18, 8), body: String(repeating: "abcdefghij", count: 8)), calendar: calendar, locale: locale)
        XCTAssertEqual(long.subline, String(repeating: "abcdefghij", count: 6))
    }

    func testPlanGroupsTodayWeekAndBeyond() throws {
        let items = [
            item("late", try date(18, 23, 59)),
            item("morning", try date(18, 9)),
            item("allday", try date(18), allDay: true),
            item("yesterday", try date(17, 23, 59)),
            item("tomorrowMidnight", try date(19)),
            item("wed", try date(21, 14)),
            item("wedAllDay", try date(21), allDay: true),
            item("lastDay", try date(24, 23, 59)),
            item("beyond", try date(25)),
            item("undated", nil)
        ]
        let plan = TodayPlan.make(items: items, now: try date(18, 12), calendar: calendar, locale: locale)
        XCTAssertEqual(plan.today.map(\.id), ["allday", "morning", "late"])
        XCTAssertEqual(plan.thisWeek.map(\.id), ["tomorrowMidnight", "wedAllDay", "wed", "lastDay"])
        XCTAssertEqual(plan.thisWeek.map(\.whenText), ["Mon 12:00 AM", "Wed", "Wed 2:00 PM", "Sat 11:59 PM"])
        XCTAssertEqual(plan.eventCountText, "3 events")
    }

    // Built the way AgendaClient reads a real all-day event: startAt at the start of its date, endAt at the next day's start.
    func testClientShapedAllDayItemsLandTodayAndThisWeek() throws {
        let holiday = AgendaItem(eventID: "holiday", title: "Holiday", isAllDay: true, startAt: try date(18), endAt: try date(19))
        let market = AgendaItem(eventID: "market", title: "Market", isAllDay: true, startAt: try date(21), endAt: try date(22))
        let plan = TodayPlan.make(items: [market, holiday], now: try date(18, 15), calendar: calendar, locale: locale)
        XCTAssertEqual(plan.today, [TodayRow(id: "holiday", title: "Holiday", subline: nil, timeText: "All day", isAllDay: true, startAt: try date(18), target: CalendarEventTarget(item: holiday))])
        XCTAssertEqual(plan.thisWeek, [WeekRow(id: "market", title: "Market", subline: nil, whenText: "Wed", target: CalendarEventTarget(item: market))])
    }

    func testAllDayDateWithoutSyntheticInstantStillAppears() throws {
        let holiday = AgendaItem(eventID: "holiday", title: "Holiday", isAllDay: true, startAt: nil, startDate: "2026-10-18", endDate: "2026-10-19", spaceID: "family")
        let plan = TodayPlan.make(items: [holiday], now: try date(18, 15), calendar: calendar, locale: locale)
        XCTAssertEqual(plan.today.map(\.title), ["Holiday"])
        XCTAssertEqual(plan.today.first?.target?.day, "2026-10-18")
    }

    func testCountTexts() throws {
        let now = try date(18, 12)
        XCTAssertEqual(TodayPlan.make(items: [], now: now, calendar: calendar, locale: locale).eventCountText, "No events")
        XCTAssertEqual(TodayPlan.make(items: [item("a", try date(18, 9))], now: now, calendar: calendar, locale: locale).eventCountText, "1 event")
        XCTAssertEqual(GetStartedStep.allCases, [.connectCalendar, .inviteFamily, .tellBobInterests])
        XCTAssertEqual(GetStartedStep.allCases.map(\.title), ["Connect your calendar", "Invite your family", "Tell Bob what you like"])
        XCTAssertTrue(GetStartedStep.allCases.allSatisfy { !$0.systemImage.isEmpty })
        XCTAssertEqual(GetStartedStep.countText, "3 steps")
    }

    func testReducerTransitions() throws {
        let first = TodayContent(plan: TodayPlan(today: [], thisWeek: []), greetingName: "Alex", loadedAt: try date(18, 9))
        let second = TodayContent(plan: TodayPlan(today: [], thisWeek: []), greetingName: nil, loadedAt: try date(18, 10))
        XCTAssertEqual(TodayState.loading.afterRefresh(.success(first)), .loaded(first))
        XCTAssertEqual(TodayState.loading.afterRefresh(.failure(.offline)), .failed(.offline))
        XCTAssertEqual(TodayState.loaded(first).afterRefresh(.failure(.offline)), .stale(first))
        XCTAssertEqual(TodayState.stale(first).afterRefresh(.failure(.server)), .stale(first))
        XCTAssertEqual(TodayState.stale(first).afterRefresh(.success(second)), .loaded(second))
        XCTAssertEqual(TodayState.failed(.offline).afterRefresh(.failure(.server)), .failed(.server))
        XCTAssertEqual(TodayState.failed(.offline).afterRefresh(.success(first)), .loaded(first))
    }

    func testStateContentAndOfflineNote() throws {
        let content = TodayContent(plan: TodayPlan(today: [], thisWeek: []), greetingName: nil, loadedAt: try date(18))
        XCTAssertNil(TodayState.loading.content)
        XCTAssertNil(TodayState.failed(.offline).content)
        XCTAssertEqual(TodayState.loaded(content).content, content)
        XCTAssertEqual(TodayState.stale(content).content, content)
        XCTAssertFalse(TodayState.loading.showsOfflineNote)
        XCTAssertFalse(TodayState.loaded(content).showsOfflineNote)
        XCTAssertFalse(TodayState.failed(.offline).showsOfflineNote)
        XCTAssertTrue(TodayState.stale(content).showsOfflineNote)
    }
}
