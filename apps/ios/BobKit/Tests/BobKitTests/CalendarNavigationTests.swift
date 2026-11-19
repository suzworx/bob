import XCTest
@testable import BobKit

final class CalendarNavigationTests: XCTestCase, @unchecked Sendable {
    func testSearchTargetLoadsEventDateAndKeepsAgendaPermissions() async throws {
        let start = try XCTUnwrap(WallClock.instant(day: "2027-03-14", time: "10:00", zone: "America/Los_Angeles"))
        let event = CalendarEvent(id: "event", spaceID: "family", title: "Trip", startAt: start, zone: "America/Los_Angeles")
        let item = AgendaItem(eventID: "event", title: "Trip", startAt: start, originalOccurrenceStart: 10, spaceID: "family", canEdit: false)
        let target = CalendarEventTarget(eventID: "event", spaceID: "family")
        let loaded = try await target.resolve(zone: "America/Los_Angeles", event: { id in
            XCTAssertEqual(id, "event")
            return event
        }, agenda: { from, to in
            XCTAssertEqual(WallClock.day(from, zone: "America/Los_Angeles"), "2027-03-14")
            XCTAssertEqual(to.timeIntervalSince(from), 23 * 3600, "Use the calendar's next day across DST")
            return AgendaPage(items: [item])
        })
        XCTAssertEqual(loaded, item)
        XCTAssertFalse(loaded.canEdit)
    }

    func testTodayTargetSelectsOnlyTheTappedOccurrence() async throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let event = CalendarEvent(id: "series", spaceID: "family", title: "Walk", startAt: start, zone: "UTC")
        let first = AgendaItem(eventID: "series", title: "Walk", startAt: start, originalOccurrenceStart: 1, spaceID: "family", canEdit: true)
        let second = AgendaItem(eventID: "series", title: "Walk", startAt: start, originalOccurrenceStart: 2, spaceID: "family", canEdit: true)
        let target = CalendarEventTarget(item: second)
        let loaded = try await target.resolve(zone: "UTC", event: { _ in event }, agenda: { _, _ in AgendaPage(items: [first, second]) })
        XCTAssertEqual(loaded.originalOccurrenceStart, 2)
        XCTAssertEqual(loaded.spaceID, "family")
    }

    func testSeriesSearchFindsLaterOccurrenceWhenFirstWasCancelled() async throws {
        let start = try XCTUnwrap(WallClock.instant(day: "2027-01-01", time: "09:00", zone: "UTC"))
        let next = start.addingTimeInterval(7 * 86400)
        let event = CalendarEvent(id: "series", spaceID: "family", title: "Walk", startAt: start, zone: "UTC", rule: ReminderRule(freq: .weekly))
        let later = AgendaItem(eventID: "series", title: "Walk", startAt: next, originalOccurrenceStart: 2, spaceID: "family", canEdit: true)
        let loaded = try await CalendarEventTarget(eventID: "series", spaceID: "family").resolve(zone: "UTC", event: { _ in event }, agenda: { _, to in
            AgendaPage(items: to > next ? [later] : [])
        })
        XCTAssertEqual(loaded, later)
    }

    func testWrongSpaceAndCancelledEventNeverLoadAgenda() async {
        let target = CalendarEventTarget(eventID: "event", spaceID: "family")
        for event in [
            CalendarEvent(id: "event", spaceID: "private", title: "Private", startAt: Date(), zone: "UTC"),
            CalendarEvent(id: "event", spaceID: "family", title: "Cancelled", startAt: Date(), zone: "UTC", status: .cancelled)
        ] {
            do {
                _ = try await target.resolve(zone: "UTC", event: { _ in event }, agenda: { _, _ in
                    XCTFail("A missing or differently scoped target must stop before loading the agenda")
                    return AgendaPage(items: [])
                })
                XCTFail("Expected unavailable event")
            } catch {
                XCTAssertEqual(error as? ApiError, .notFound)
            }
        }
    }

    func testMissingOccurrenceCannotOpenAnotherOccurrenceOrSpace() async throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let event = CalendarEvent(id: "series", spaceID: "family", title: "Walk", startAt: start, zone: "UTC")
        let tapped = AgendaItem(eventID: "series", title: "Walk", startAt: start, originalOccurrenceStart: 2, spaceID: "family")
        let differentOccurrence = AgendaItem(eventID: "series", title: "Walk", startAt: start, originalOccurrenceStart: 1, spaceID: "family")
        let differentSpace = AgendaItem(eventID: "series", title: "Walk", startAt: start, originalOccurrenceStart: 2, spaceID: "other")
        do {
            _ = try await CalendarEventTarget(item: tapped).resolve(zone: "UTC", event: { _ in event }, agenda: { _, _ in AgendaPage(items: [differentOccurrence, differentSpace]) })
            XCTFail("Expected unavailable occurrence")
        } catch {
            XCTAssertEqual(error as? ApiError, .notFound)
        }
    }

    func testTransportFailureRemainsRetryableRatherThanMissing() async {
        do {
            _ = try await CalendarEventTarget(eventID: "event", spaceID: "family").resolve(zone: "UTC", event: { _ in throw ApiError.offline }, agenda: { _, _ in AgendaPage(items: []) })
            XCTFail("Expected offline error")
        } catch {
            XCTAssertEqual(error as? ApiError, .offline)
        }
    }

    func testAllDayEventUsesItsDateInTheReadersZone() async throws {
        let event = CalendarEvent(id: "all-day", spaceID: "family", title: "Holiday", allDay: true, startDate: "2027-01-01", endDate: "2027-01-02", zone: "Pacific/Auckland")
        let item = AgendaItem(eventID: "all-day", title: "Holiday", isAllDay: true, startAt: nil, startDate: "2027-01-01", endDate: "2027-01-02", spaceID: "family")
        _ = try await CalendarEventTarget(eventID: "all-day", spaceID: "family").resolve(zone: "America/Los_Angeles", event: { _ in event }, agenda: { from, _ in
            XCTAssertEqual(WallClock.day(from, zone: "America/Los_Angeles"), "2027-01-01")
            return AgendaPage(items: [item])
        })
    }
}
