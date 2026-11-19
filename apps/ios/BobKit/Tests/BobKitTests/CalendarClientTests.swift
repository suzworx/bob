import XCTest
@testable import BobKit

private let base = URL(string: "https://api.example.test")!
private let spaceID = "11111111-1111-4111-8111-111111111111"
private let eventID = "22222222-2222-4222-8222-222222222222"
private let calendarID = "33333333-3333-4333-8333-333333333333"
private let userID = "44444444-4444-4444-8444-444444444444"
private let start: Int64 = 1_792_000_000_000

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from toEventSummary in apps/api/src/calendar/http.ts.
private func eventJSON(rule: String = "null", status: String = "confirmed") -> String {
    #"{"id":"\#(eventID)","calendar_id":"\#(calendarID)","space_id":"\#(spaceID)","uid":"u1","sequence":0,"organizer_user_id":"\#(userID)","title":"Dentist","location":"Elm St","body":null,"all_day":false,"start_date":null,"end_date":null,"start_at":\#(start),"end_at":\#(start + 3_600_000),"zone":"Europe/London","rrule":\#(rule),"status":"\#(status)","revision":4,"created_at":1700000000000,"updated_at":1700000001000}"#
}

// Copied from toAttendeeSummary.
private func attendeeJSON(response: String = "accepted") -> String {
    #"{"event_id":"\#(eventID)","user_id":"\#(userID)","email":null,"response":"\#(response)","role":"required"}"#
}

// Copied from toAgendaItem.
private func agendaItemJSON() -> String {
    #"{"event_id":"\#(eventID)","uid":"u1","title":"Holiday","location":null,"body":null,"all_day":true,"start_date":"2026-11-02","end_date":"2026-11-04","start_at":null,"end_at":null,"zone":"UTC","original_occurrence_start":\#(start),"cancelled":false,"moved":false,"my_response":"tentative","calendar_id":"\#(calendarID)","space_id":"\#(spaceID)","origin":"native","can_edit":true,"can_delete":true}"#
}

final class CalendarClientTests: XCTestCase {
    private let client = CalendarClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
    private var space: SpaceSummary { SpaceSummary(id: spaceID, kind: .private, name: "Personal") }

    override func setUp() { ProductivityStub.reset() }

    func testDefaultCalendarIsTheSpacesFirst() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/calendars", 200, #"{"calendars":[{"id":"\#(calendarID)","space_id":"\#(spaceID)","name":"Private","zone":"UTC","origin":"native","created_by":"\#(userID)","created_at":1,"updated_at":1}]}"#)
        let id = try await client.defaultCalendarID(space: space, zone: "UTC")
        XCTAssertEqual(id, calendarID)
        XCTAssertEqual(ProductivityStub.all.count, 1)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }

    func testDefaultCalendarIsCreatedWhenTheSpaceHasNone() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/calendars", 200, #"{"calendars":[]}"#)
        ProductivityStub.route("POST /api/spaces/\(spaceID)/calendars", 201, #"{"id":"\#(calendarID)","space_id":"\#(spaceID)","name":"Private","zone":"UTC","origin":"native","created_by":"\#(userID)","created_at":1,"updated_at":1}"#)
        let id = try await client.defaultCalendarID(space: space, zone: "Europe/London")
        XCTAssertEqual(id, calendarID)
        XCTAssertEqual(ProductivityStub.last?.body?["name"] as? String, "Private")
        XCTAssertEqual(ProductivityStub.last?.body?["zone"] as? String, "Europe/London")
    }

    func testCreateTimedSendsInstantsAndNoDates() async throws {
        ProductivityStub.route("POST /api/calendars/\(calendarID)/events", 201, eventJSON())
        let at = Date(timeIntervalSince1970: Double(start) / 1000)
        let event = try await client.create(calendarID: calendarID, event: NewEvent(title: "Dentist", location: "Elm St", zone: "UTC", timing: .timed(start: at, end: at.addingTimeInterval(3600))))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/calendars/\(calendarID)/events")
        XCTAssertEqual(body["title"] as? String, "Dentist")
        XCTAssertEqual(body["location"] as? String, "Elm St")
        XCTAssertTrue(body["body"] is NSNull)
        XCTAssertEqual(body["all_day"] as? Bool, false)
        XCTAssertEqual((body["start_at"] as? NSNumber)?.int64Value, start)
        XCTAssertEqual((body["end_at"] as? NSNumber)?.int64Value, start + 3_600_000)
        XCTAssertNil(body["start_date"])
        XCTAssertNil(body["end_date"])
        XCTAssertEqual(event.revision, 4)
        XCTAssertEqual(event.startAt, at)
        XCTAssertNil(event.rule)
    }

    func testCreateAllDaySendsDatesAndNoInstants() async throws {
        ProductivityStub.route("POST /api/calendars/\(calendarID)/events", 201, eventJSON())
        _ = try await client.create(calendarID: calendarID, event: NewEvent(title: "Trip", zone: "UTC", timing: .allDay(startDate: "2026-11-02", endDate: "2026-11-04")))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["all_day"] as? Bool, true)
        XCTAssertEqual(body["start_date"] as? String, "2026-11-02")
        XCTAssertEqual(body["end_date"] as? String, "2026-11-04")
        XCTAssertNil(body["start_at"])
    }

    func testDecodesARepeatingEvent() async throws {
        ProductivityStub.route("GET /api/events/\(eventID)", 200, eventJSON(rule: #"{"freq":"weekly","interval":2,"byWeekday":[1,3]}"#))
        let event = try await client.event(id: eventID)
        XCTAssertEqual(event.rule, ReminderRule(freq: .weekly, interval: 2, byWeekday: [1, 3]))
        XCTAssertEqual(event.location, "Elm St")
        XCTAssertEqual(event.status, .confirmed)
    }

    func testEditOfOneDateSendsItsOccurrenceAndAPatch() async throws {
        ProductivityStub.route("PATCH /api/events/\(eventID)", 200, eventJSON())
        _ = try await client.update(id: eventID, revision: 4, scope: .this, occurrenceStart: start, patch: EventPatch(title: "New", location: .some(nil)))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["revision"] as? Int, 4)
        XCTAssertEqual(body["scope"] as? String, "this")
        XCTAssertEqual((body["occurrence_start"] as? NSNumber)?.int64Value, start)
        let patch = try XCTUnwrap(body["patch"] as? [String: Any])
        XCTAssertEqual(patch["title"] as? String, "New")
        XCTAssertTrue(patch["location"] is NSNull)
        XCTAssertNil(patch["body"])
        XCTAssertNil(patch["all_day"])
    }

    func testSeriesEditSendsNoOccurrence() async throws {
        ProductivityStub.route("PATCH /api/events/\(eventID)", 200, eventJSON())
        _ = try await client.update(id: eventID, revision: 4, scope: .series, occurrenceStart: start, patch: EventPatch(title: "New"))
        XCTAssertEqual(ProductivityStub.last?.body?["scope"] as? String, "series")
        XCTAssertNil(ProductivityStub.last?.body?["occurrence_start"])
    }

    func testAScopeThatNeedsAnOccurrenceIsRefusedBeforeSending() async {
        do {
            _ = try await client.cancel(id: eventID, scope: .thisAndFollowing, occurrenceStart: nil)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .invalidRequest)
        }
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }

    func testCancelCarriesItsScopeInTheBody() async throws {
        ProductivityStub.route("DELETE /api/events/\(eventID)", 200, eventJSON(status: "cancelled"))
        let event = try await client.cancel(id: eventID, scope: .thisAndFollowing, occurrenceStart: start)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        XCTAssertEqual(ProductivityStub.last?.body?["scope"] as? String, "this_and_following")
        XCTAssertEqual((ProductivityStub.last?.body?["occurrence_start"] as? NSNumber)?.int64Value, start)
        XCTAssertEqual(event.status, .cancelled)
    }

    func testStaleEditArrivesAs409() async {
        ProductivityStub.route("PATCH /api/events/\(eventID)", 409, #"{"error":{"code":"conflict"}}"#)
        do {
            _ = try await client.update(id: eventID, revision: 1, scope: .series, occurrenceStart: nil, patch: EventPatch(title: "x"))
            XCTFail("expected a conflict")
        } catch {
            XCTAssertEqual(error as? ApiError, .unknown(status: 409))
        }
    }

    func testAttendees() async throws {
        ProductivityStub.route("GET /api/events/\(eventID)/attendees", 200, #"{"attendees":[\#(attendeeJSON())]}"#)
        let attendees = try await client.attendees(eventID: eventID)
        XCTAssertEqual(attendees, [EventAttendee(userID: userID, response: .accepted)])

        ProductivityStub.route("POST /api/events/\(eventID)/attendees", 201, attendeeJSON(response: "needs_action"))
        let added = try await client.addAttendee(eventID: eventID, userID: userID)
        XCTAssertEqual(added.response, .needsAction)
        XCTAssertEqual(ProductivityStub.last?.body?["user_id"] as? String, userID)
        XCTAssertEqual(ProductivityStub.last?.body?["role"] as? String, "required")

        ProductivityStub.route("DELETE /api/events/\(eventID)/attendees", 204, "")
        try await client.removeAttendee(eventID: eventID, userID: userID)
        XCTAssertEqual(ProductivityStub.last?.query, "user_id=\(userID)")
    }

    func testRsvpIsAPut() async throws {
        ProductivityStub.route("PUT /api/events/\(eventID)/rsvp", 200, attendeeJSON(response: "declined"))
        let mine = try await client.setResponse(eventID: eventID, response: .declined)
        XCTAssertEqual(mine.response, .declined)
        XCTAssertEqual(ProductivityStub.last?.body?["response"] as? String, "declined")
    }

    func testAgendaPageDecodesEventsAndGoogle() async throws {
        let client = AgendaClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
        let google = #"{"origin":"google","source_key":"google:abc","source":{"account_id":"a","calendar_id":"c","event_id":"e","etag":"t"},"title":"Standup","location":null,"start":{"dateTime":"2026-11-02T09:00:00+00:00"},"end":{"dateTime":"2026-11-02T09:15:00.000Z"},"read_only":true,"fetched_at":1700000000000}"#
        ProductivityStub.route("GET /api/agenda", 200, #"{"items":[\#(agendaItemJSON())],"remote_items":[\#(google)],"sources":[{"account_id":"a","calendar_id":"c","state":"partial","last_success_at":null}]}"#)
        let page = try await client.page(from: Date(timeIntervalSince1970: 1), to: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(ProductivityStub.last?.query, "from=1000&to=2000")
        let item = try XCTUnwrap(page.items.first)
        XCTAssertEqual(item.startDate, "2026-11-02")
        XCTAssertEqual(item.endDate, "2026-11-04")
        XCTAssertEqual(item.originalOccurrenceStart, start)
        XCTAssertEqual(item.myResponse, .tentative)
        XCTAssertEqual(item.spaceID, spaceID)
        XCTAssertTrue(item.canEdit)
        XCTAssertTrue(item.canDelete)
        XCTAssertEqual(page.googleItems.first?.title, "Standup")
        XCTAssertEqual(page.googleItems.first?.endAt?.timeIntervalSince1970, 1_793_610_900)
        XCTAssertEqual(page.googleNotice, .incomplete)
    }

    func testAgendaPageSaysWhenGoogleNeedsReconnecting() async throws {
        let client = AgendaClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
        ProductivityStub.route("GET /api/agenda", 200, #"{"items":[],"remote_items":[],"sources":[{"state":"partial"},{"state":"reconnect_required"}]}"#)
        let page = try await client.page(from: Date(timeIntervalSince1970: 1), to: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(page.googleNotice, .reconnect)
    }

    func testAgendaPageKeepsOwnEventsWhenGoogleRowsAreUnreadable() async throws {
        let client = AgendaClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
        ProductivityStub.route("GET /api/agenda", 200, #"{"items":[\#(agendaItemJSON())],"remote_items":[{"nonsense":1}]}"#)
        let page = try await client.page(from: Date(timeIntervalSince1970: 1), to: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(page.items.count, 1)
        XCTAssertTrue(page.googleItems.isEmpty)
        XCTAssertEqual(page.googleNotice, .incomplete)
    }

    func testAgendaWithoutGoogleSaysNothingAboutIt() async throws {
        let client = AgendaClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
        ProductivityStub.route("GET /api/agenda", 200, #"{"items":[]}"#)
        let page = try await client.page(from: Date(timeIntervalSince1970: 1), to: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(page.googleNotice, .none)
    }
}

final class CalendarDaysTests: XCTestCase {
    func testAddingDaysCrossesMonthsAndYears() {
        XCTAssertEqual(CalendarDays.add(1, to: "2026-12-31"), "2027-01-01")
        XCTAssertEqual(CalendarDays.add(-1, to: "2026-03-01"), "2026-02-28")
        XCTAssertEqual(CalendarDays.addMonths(1, to: "2026-12"), "2027-01")
        XCTAssertEqual(CalendarDays.addMonths(-1, to: "2026-01"), "2025-12")
    }

    func testAMonthOpensOnTodayOrItsFirst() {
        XCTAssertEqual(CalendarDays.openingDay(of: "2026-11", today: "2026-11-02"), "2026-11-02")
        XCTAssertEqual(CalendarDays.openingDay(of: "2026-12", today: "2026-11-02"), "2026-12-01")
    }

    func testAMonthIsWholeWeeksFromMonday() throws {
        // November 2026 starts on a Sunday, so its first week is almost all October.
        let weeks = CalendarDays.weeks(of: "2026-11")
        XCTAssertEqual(weeks.first?.first, "2026-10-26")
        XCTAssertEqual(weeks.first?.last, "2026-11-01")
        XCTAssertEqual(weeks.last?.last, "2026-12-06")
        XCTAssertTrue(weeks.allSatisfy { $0.count == 7 })
        XCTAssertEqual(weeks.count, 6)
    }

    func testMonthThatEndsOnASundayHasNoExtraWeek() {
        // May 2026 ends on Sunday the 31st.
        XCTAssertEqual(CalendarDays.weeks(of: "2026-05").last?.last, "2026-05-31")
    }

    func testWeekdaySymbolsStartOnMonday() {
        XCTAssertEqual(CalendarDays.weekdaySymbols(locale: Locale(identifier: "en_US")), ["M", "T", "W", "T", "F", "S", "S"])
    }

    func testGroupTitlesCount() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(CalendarDays.groupTitle("2026-11-02", today: "2026-11-02", count: 3, locale: locale), "Today, 3")
        XCTAssertEqual(CalendarDays.groupTitle("2026-11-03", today: "2026-11-02", count: 1, locale: locale), "Tomorrow, 1")
        XCTAssertEqual(CalendarDays.groupTitle("2026-11-05", today: "2026-11-02", count: 2, locale: locale), "Thu, Nov 5, 2")
    }

    func testLoadWindowRunsPastTheGridForComingUp() throws {
        let window = try XCTUnwrap(CalendarDays.loadWindow(month: "2026-11", comingUpDays: 7, zone: "UTC"))
        XCTAssertEqual(window.days.first, "2026-10-26")
        XCTAssertEqual(window.days.last, "2026-12-13")
        XCTAssertEqual(WallClock.day(window.from, zone: "UTC"), "2026-10-26")
        XCTAssertEqual(WallClock.day(window.to, zone: "UTC"), "2026-12-14")
    }
}

final class CalendarRulesTests: XCTestCase {
    private let space = SpaceSummary(id: "s", kind: .private, name: "Personal")
    private let zone = "UTC"
    private let now = WallClock.instant(day: "2026-11-02", time: "08:00", zone: "UTC")!

    private func at(_ day: String, _ time: String = "09:00") -> Date {
        WallClock.instant(day: day, time: time, zone: "UTC")!
    }

    private func reminder(_ rule: ReminderRule?, due: Date, zone: String = "UTC", status: Reminder.Status = .active) -> Reminder {
        Reminder(id: "r", spaceID: "s", title: "Ring", dueAt: due, dueZone: zone, rule: rule, status: status)
    }

    private func task(_ id: String, due: TaskDue?, status: TaskStatus = .open, assignee: String? = nil, trashed: Date? = nil) -> TaskItem {
        TaskItem(id: id, spaceID: "s", title: id, status: status, assigneeUserID: assignee, due: due, orderKey: "a", createdBy: "u", trashedAt: trashed, createdAt: now, updatedAt: now)
    }

    private func entries(page: AgendaPage? = nil, tasks: [TaskItem] = [], reminders: [Reminder] = [], days: [String], me: String? = "me") -> [String: [CalendarEntry]] {
        CalendarRules.entries(page: page, tasks: [(space, tasks)], reminders: [(space, reminders)], spaces: [space], days: days, me: me, now: now, zone: zone)
    }

    func testEventsTasksAndRemindersShareADayInTimeOrder() {
        let event = AgendaItem(eventID: "e", title: "Event", startAt: at("2026-11-02", "10:00"), spaceID: "s")
        let byDay = entries(
            page: AgendaPage(items: [event]),
            tasks: [task("timed", due: .instant(at: at("2026-11-02", "11:00"), zone: "UTC")), task("dated", due: .date("2026-11-02"))],
            reminders: [reminder(nil, due: at("2026-11-02", "09:30"))],
            days: ["2026-11-02"]
        )
        XCTAssertEqual(byDay["2026-11-02"]?.map(\.title), ["dated", "Ring", "Event", "timed"])
        XCTAssertEqual(byDay["2026-11-02"]?[2].spaceName, "Personal")
    }

    func testTasksThatDoNotBelongOnADayAreLeftOut() {
        let byDay = entries(tasks: [
            task("undated", due: nil),
            task("done", due: .date("2026-11-02"), status: .completed),
            task("trashed", due: .date("2026-11-02"), trashed: now),
            task("theirs", due: .date("2026-11-02"), assignee: "other"),
            task("mine", due: .date("2026-11-02"), assignee: "me"),
            task("anyone", due: .date("2026-11-02")),
            task("elsewhere", due: .date("2026-11-20"))
        ], days: ["2026-11-02"])
        XCTAssertEqual(Set(byDay["2026-11-02"]?.map(\.title) ?? []), ["mine", "anyone"])
    }

    func testAMultiDayEventIsOnEachOfItsDaysAndNotTheOneAfter() {
        let trip = AgendaItem(eventID: "e", title: "Trip", isAllDay: true, startAt: nil, startDate: "2026-11-02", endDate: "2026-11-04")
        let byDay = entries(page: AgendaPage(items: [trip]), days: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"])
        XCTAssertNil(byDay["2026-11-01"])
        XCTAssertEqual(byDay["2026-11-02"]?.count, 1)
        XCTAssertEqual(byDay["2026-11-03"]?.count, 1)
        XCTAssertNil(byDay["2026-11-04"])
    }

    func testGoogleRowsAreReadOnlyAndHaveNoSpace() throws {
        let google = GoogleAgendaItem(sourceKey: "g", title: "Standup", startAt: at("2026-11-02", "12:00"), fetchedAt: now)
        let entry = try XCTUnwrap(entries(page: AgendaPage(items: [], googleItems: [google]), days: ["2026-11-02"])["2026-11-02"]?.first)
        XCTAssertNil(entry.spaceName)
        XCTAssertEqual(CalendarRules.subline(entry, zone: zone, locale: Locale(identifier: "en_US")).replacingOccurrences(of: "\u{202F}", with: " "), "12:00 PM · Google · Read-only")
    }

    func testATimedEventIsOnTheDayItFallsOnInTheReadersZone() {
        let late = AgendaItem(eventID: "e", title: "Late", startAt: at("2026-11-03", "02:00"))
        let byDay = CalendarRules.entries(page: AgendaPage(items: [late]), tasks: [], reminders: [], spaces: [], days: ["2026-11-02", "2026-11-03"], me: nil, now: now, zone: "America/New_York")
        XCTAssertEqual(byDay["2026-11-02"]?.count, 1)
        XCTAssertNil(byDay["2026-11-03"])
    }

    func testOneOffReminderRingsOnlyItsDay() {
        let once = reminder(nil, due: at("2026-11-02"))
        XCTAssertEqual(CalendarRules.reminderInstants(once, on: "2026-11-02", zone: zone), [at("2026-11-02")])
        XCTAssertTrue(CalendarRules.reminderInstants(once, on: "2026-11-03", zone: zone).isEmpty)
    }

    func testCancelledAndPausedRemindersDoNotRing() {
        for status in [Reminder.Status.cancelled, .paused] {
            XCTAssertTrue(CalendarRules.reminderInstants(reminder(nil, due: at("2026-11-02"), status: status), on: "2026-11-02", zone: zone).isEmpty)
        }
    }

    func testRepeatingRules() {
        let due = at("2026-11-02") // a Monday
        let days = ["2026-11-02", "2026-11-03", "2026-11-09", "2026-11-16"]
        func rings(_ rule: ReminderRule) -> [String] {
            days.filter { !CalendarRules.reminderInstants(reminder(rule, due: due), on: $0, zone: zone).isEmpty }
        }
        XCTAssertEqual(rings(ReminderRule(freq: .daily)), days)
        XCTAssertEqual(rings(ReminderRule(freq: .weekly)), ["2026-11-02", "2026-11-09", "2026-11-16"])
        XCTAssertEqual(rings(ReminderRule(freq: .weekly, interval: 2)), ["2026-11-02", "2026-11-16"])
        XCTAssertEqual(rings(ReminderRule(freq: .weekly, byWeekday: [2])), ["2026-11-03"])
        XCTAssertEqual(rings(ReminderRule(freq: .daily, until: "2026-11-03")), ["2026-11-02", "2026-11-03"])
        XCTAssertTrue(CalendarRules.reminderInstants(reminder(ReminderRule(freq: .daily), due: due), on: "2026-11-01", zone: zone).isEmpty)
        XCTAssertFalse(CalendarRules.reminderInstants(reminder(ReminderRule(freq: .monthly), due: due), on: "2026-12-02", zone: zone).isEmpty)
        XCTAssertFalse(CalendarRules.reminderInstants(reminder(ReminderRule(freq: .yearly), due: due), on: "2027-11-02", zone: zone).isEmpty)
        XCTAssertTrue(CalendarRules.reminderInstants(reminder(ReminderRule(freq: .yearly), due: due), on: "2027-11-03", zone: zone).isEmpty)
    }

    func testARuleRunsInTheRemindersOwnZone() {
        // 23:30 in New York is the next day in UTC.
        let due = WallClock.instant(day: "2026-11-02", time: "23:30", zone: "America/New_York")!
        let rings = CalendarRules.reminderInstants(reminder(ReminderRule(freq: .daily), due: due, zone: "America/New_York"), on: "2026-11-05", zone: "UTC")
        XCTAssertEqual(rings.map { WallClock.time($0, zone: "America/New_York") }, ["23:30"])
    }

    func testHourlyReminderIsOneRowAtItsNextRing() throws {
        let rule = ReminderRule(freq: .hourly, interval: 2, window: .init(start: "08:00", end: "12:00"))
        let due = at("2026-11-01", "08:00")
        XCTAssertEqual(CalendarRules.reminderInstants(reminder(rule, due: due), on: "2026-11-02", zone: zone).count, 3)
        let row = try XCTUnwrap(entries(reminders: [reminder(rule, due: due)], days: ["2026-11-02"])["2026-11-02"])
        XCTAssertEqual(row.count, 1)
        guard case .reminder(_, let ring) = row[0].kind else { return XCTFail("expected a reminder") }
        XCTAssertEqual(ring, at("2026-11-02", "08:00"))
    }

    func testSublines() {
        let locale = Locale(identifier: "en_US")
        func subline(_ kind: CalendarEntry.Kind) -> String {
            CalendarRules.subline(CalendarEntry(id: "x", title: "x", day: "2026-11-02", sortAt: now, spaceName: "Personal", kind: kind), zone: zone, locale: locale).replacingOccurrences(of: "\u{202F}", with: " ")
        }
        XCTAssertEqual(subline(.event(AgendaItem(eventID: "e", title: "x", isAllDay: true, startAt: nil, myResponse: .accepted))), "All day · Personal · Going")
        XCTAssertEqual(subline(.event(AgendaItem(eventID: "e", title: "x", startAt: at("2026-11-02", "15:00")))), "3:00 PM · Personal")
        XCTAssertEqual(subline(.task(task("t", due: .date("2026-11-02")))), "Task · Personal")
        XCTAssertEqual(subline(.reminder(reminder(nil, due: now), at: now)), "Reminder · Personal · 8:00 AM")
        XCTAssertEqual(subline(.reminder(reminder(ReminderRule(freq: .daily), due: now), at: now)), "Every day · Personal · 8:00 AM")
    }

    func testAttendeeNamesNeverShowAnID() {
        let members = [SpaceMember(userID: "a", displayName: "Sam"), SpaceMember(userID: "b", handle: "kay"), SpaceMember(userID: "c")]
        XCTAssertEqual(CalendarRules.attendeeName(EventAttendee(userID: "a", email: "s@x.test"), members: members), "Sam")
        XCTAssertEqual(CalendarRules.attendeeName(EventAttendee(userID: "b"), members: members), "@kay")
        XCTAssertEqual(CalendarRules.attendeeName(EventAttendee(userID: "c"), members: members), "Someone")
        XCTAssertEqual(CalendarRules.attendeeName(EventAttendee(userID: nil, email: "guest@x.test"), members: members), "guest@x.test")
        XCTAssertEqual(CalendarRules.attendeeName(EventAttendee(userID: "z"), members: members), "Someone")
    }
}

final class EventDraftTests: XCTestCase {
    private let zone = "UTC"

    func testNewDraftIsNineToTenAndNeedsATitle() {
        var draft = EventDraft(day: "2026-11-02")
        XCTAssertEqual(draft.startLocal, "2026-11-02T09:00")
        XCTAssertEqual(draft.endLocal, "2026-11-02T10:00")
        XCTAssertFalse(draft.isValid(zone: zone))
        draft.title = "  "
        XCTAssertFalse(draft.isValid(zone: zone))
        draft.title = " Lunch "
        XCTAssertTrue(draft.isValid(zone: zone))
        XCTAssertEqual(draft.newEvent(zone: zone)?.title, "Lunch")
        XCTAssertNil(draft.newEvent(zone: zone)?.location)
    }

    func testEndBeforeStartIsInvalid() {
        var draft = EventDraft(day: "2026-11-02")
        draft.title = "x"
        draft.endLocal = "2026-11-02T08:00"
        XCTAssertFalse(draft.isValid(zone: zone))
        XCTAssertNil(draft.newEvent(zone: zone))
    }

    func testAllDayEndIsExclusiveOnTheWire() {
        var draft = EventDraft(day: "2026-11-02").settingAllDay(true)
        draft.endDateInclusive = "2026-11-03"
        XCTAssertEqual(draft.timing(zone: zone), .allDay(startDate: "2026-11-02", endDate: "2026-11-04"))
        draft.endDateInclusive = "2026-11-01"
        XCTAssertNil(draft.timing(zone: zone))
    }

    func testAnOccurrenceReadsBackAsAPersonSeesIt() {
        let item = AgendaItem(eventID: "e", title: "Trip", location: "Rome", isAllDay: true, startAt: nil, startDate: "2026-11-02", endDate: "2026-11-04")
        let draft = EventDraft(occurrence: item, zone: zone)
        XCTAssertEqual(draft.endDateInclusive, "2026-11-03")
        XCTAssertEqual(draft.location, "Rome")
        XCTAssertTrue(draft.allDay)
    }

    func testTogglingAllDayKeepsTheDaysAndNeverSendsAnEmptyOne() {
        var timed = EventDraft(day: "2026-11-02")
        timed.endLocal = "2026-11-03T10:00"
        timed.startDate = ""
        timed.endDateInclusive = ""
        let allDay = timed.settingAllDay(true)
        XCTAssertEqual(allDay.startDate, "2026-11-02")
        XCTAssertEqual(allDay.endDateInclusive, "2026-11-03")

        let fromAllDay = EventDraft(occurrence: AgendaItem(eventID: "e", title: "T", isAllDay: true, startAt: nil, startDate: "2026-11-02", endDate: "2026-11-03"), zone: zone).settingAllDay(false)
        XCTAssertEqual(fromAllDay.startLocal, "2026-11-02T09:00")
        XCTAssertEqual(fromAllDay.endLocal, "2026-11-02T10:00")
    }

    func testPatchHoldsOnlyWhatChanged() {
        let start = WallClock.instant(day: "2026-11-02", time: "09:00", zone: zone)!
        let item = AgendaItem(eventID: "e", title: "Lunch", location: "Cafe", body: "Notes", startAt: start, endAt: start.addingTimeInterval(3600))
        let initial = EventDraft(occurrence: item, zone: zone)
        XCTAssertTrue(initial.patch(from: initial, zone: zone).isEmpty)

        var draft = initial
        draft.title = "Brunch"
        XCTAssertEqual(draft.patch(from: initial, zone: zone), EventPatch(title: "Brunch"))

        draft = initial
        draft.location = "  "
        XCTAssertEqual(draft.patch(from: initial, zone: zone), EventPatch(location: .some(nil)))

        draft = initial
        draft.endLocal = "2026-11-02T11:00"
        XCTAssertEqual(draft.patch(from: initial, zone: zone), EventPatch(timing: .timed(start: start, end: start.addingTimeInterval(7200))))
    }

    func testRestoringTimesForASeries() {
        let initial = EventDraft(day: "2026-11-02")
        var draft = initial.settingAllDay(true)
        draft.title = "Kept"
        let restored = draft.restoringTimes(from: initial)
        XCTAssertFalse(restored.allDay)
        XCTAssertEqual(restored.title, "Kept")
        XCTAssertEqual(restored.startLocal, initial.startLocal)
    }

    func testPastDatesAreOnlyAWarning() {
        let now = WallClock.instant(day: "2026-11-02", zone: zone)!
        XCTAssertTrue(EventDraft(day: "2026-11-01").startsBeforeToday(now: now, zone: zone))
        XCTAssertFalse(EventDraft(day: "2026-11-02").startsBeforeToday(now: now, zone: zone))
    }

    func testANewEventTodayStartsAtTheNextHour() {
        let zone = "UTC"
        let now = Date(timeIntervalSince1970: 1_793_399_400) // 22:30 UTC
        let today = String(EventDraft.local(now, zone: zone).prefix(10))
        let late = EventDraft(day: today, now: now, zone: zone)
        XCTAssertEqual(late.startLocal, "\(today)T23:00")
        XCTAssertEqual(late.endLocal, "\(today)T23:59")
        let other = EventDraft(day: "2031-01-01", now: now, zone: zone)
        XCTAssertEqual(other.startLocal, "2031-01-01T09:00")
        let morning = now.addingTimeInterval(-16 * 3600)
        XCTAssertEqual(EventDraft(day: today, now: morning, zone: zone).startLocal, "\(today)T09:00")
    }
}
