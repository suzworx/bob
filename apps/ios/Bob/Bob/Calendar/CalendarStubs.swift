import BobKit
import Foundation

// Made-up events for previews and the demo build: no network, and every action works. Tasks and reminders come from the demo's own services.
actor StubCalendarService: CalendarService {
    nonisolated private static let familySpace = "demo-family"
    nonisolated private static let otherPerson = "demo-sam"

    private struct Stored {
        var event: CalendarEvent
        var canEdit: Bool
        var attendees: [EventAttendee]
    }

    private var stored: [Stored] = []
    // Single dates of a series, moved or changed on their own, and ones deleted.
    private var overrides: [String: CalendarEvent] = [:]
    private var removed: Set<String> = []
    private var endsBefore: [String: Date] = [:]
    private let tasks: TasksService
    private let reminders: RemindersService
    private let zone = TimeZone.current.identifier
    private let isEmpty: Bool

    init(tasks: TasksService, reminders: RemindersService, empty: Bool = false, now: Date = Date()) {
        self.tasks = tasks
        self.reminders = reminders
        isEmpty = empty
        guard !empty else { return }
        let zone = TimeZone.current.identifier
        let today = WallClock.day(now, zone: zone)
        func at(_ offset: Int, _ time: String) -> Date {
            WallClock.instant(day: CalendarDays.add(offset, to: today), time: time, zone: zone) ?? now
        }
        let family = "demo-family"
        func timed(_ id: String, _ title: String, _ offset: Int, _ time: String, location: String? = nil, space: String = demoSpace, rule: ReminderRule? = nil) -> CalendarEvent {
            CalendarEvent(id: id, spaceID: space, title: title, location: location, startAt: at(offset, time), endAt: at(offset, time).addingTimeInterval(3600), zone: zone, rule: rule)
        }
        stored = [
            Stored(event: timed("demo-e1", "Dentist visit", 0, "10:30", location: "48 Elm Street"), canEdit: true, attendees: []),
            Stored(event: timed("demo-e2", "Book club", 2, "19:30", location: "Library, room 2", rule: ReminderRule(freq: .weekly)), canEdit: true, attendees: []),
            Stored(event: CalendarEvent(id: "demo-e3", spaceID: demoSpace, title: "Weekend away", allDay: true, startDate: CalendarDays.add(4, to: today), endDate: CalendarDays.add(6, to: today), zone: zone), canEdit: true, attendees: []),
            Stored(
                event: timed("demo-e4", "Family dinner", 1, "18:00", location: "Sam's place", space: family),
                canEdit: false,
                attendees: [EventAttendee(userID: "demo-sam", response: .accepted), EventAttendee(userID: demoUser, response: .needsAction)]
            )
        ]
    }

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    private func index(_ id: String) throws -> Int {
        guard let index = stored.firstIndex(where: { $0.event.id == id }) else { throw ApiError.notFound }
        return index
    }

    private func key(_ id: String, _ start: Int64) -> String { "\(id):\(start)" }

    private func occurrence(_ item: Stored, event: CalendarEvent, original: Date) -> AgendaItem {
        let myResponse = item.attendees.first { $0.userID == demoUser }?.response
        return AgendaItem(
            eventID: item.event.id,
            title: event.title,
            location: event.location,
            body: event.body,
            isAllDay: event.allDay,
            startAt: event.startAt,
            endAt: event.endAt,
            zoneID: event.zone,
            originalOccurrenceStart: Int64(original.timeIntervalSince1970 * 1000),
            startDate: event.startDate,
            endDate: event.endDate,
            spaceID: event.spaceID,
            canEdit: item.canEdit,
            canDelete: item.canEdit,
            myResponse: myResponse
        )
    }

    func agenda(from: Date, to: Date) async throws -> AgendaPage {
        try await pause()
        var items: [AgendaItem] = []
        for item in stored where item.event.status == .confirmed {
            let event = item.event
            guard event.rule?.freq == .weekly, let first = event.startAt else {
                let start = event.startAt ?? event.startDate.flatMap { WallClock.instant(day: $0, zone: zone) } ?? from
                let end = event.endAt ?? event.endDate.flatMap { WallClock.instant(day: $0, zone: zone) } ?? start
                if start < to, end >= from {
                    items.append(occurrence(item, event: event, original: start))
                }
                continue
            }
            let length = (event.endAt ?? first).timeIntervalSince(first)
            var week = 0
            var start = first
            while start < to, week < 200 {
                let startKey = key(event.id, Int64(start.timeIntervalSince1970 * 1000))
                let ended = endsBefore[event.id].map { start >= $0 } ?? false
                if start >= from, !ended, !removed.contains(startKey) {
                    var shown = event
                    shown.startAt = start
                    shown.endAt = start.addingTimeInterval(length)
                    items.append(occurrence(item, event: overrides[startKey] ?? shown, original: start))
                }
                week += 1
                start = Calendar.current.date(byAdding: .day, value: 7 * week, to: first) ?? to
            }
        }
        return AgendaPage(items: items)
    }

    func spaces() async throws -> [SpaceSummary] {
        [SpaceSummary(id: demoSpace, kind: .private, name: "Personal"), SpaceSummary(id: Self.familySpace, kind: .group, name: "Family")]
    }

    func selfUserID() async throws -> String? { demoUser }

    func tasks(spaceID: String) async throws -> [TaskItem] {
        guard spaceID == demoSpace, !isEmpty else { return [] }
        return try await tasks.tasks()
    }

    func reminders(spaceID: String) async throws -> [Reminder] {
        guard spaceID == demoSpace, !isEmpty else { return [] }
        return try await reminders.reminders()
    }

    func members(spaceID: String) async throws -> [SpaceMember] {
        spaceID == Self.familySpace
            ? [SpaceMember(userID: demoUser, displayName: "You"), SpaceMember(userID: Self.otherPerson, displayName: "Sam"), SpaceMember(userID: "demo-kay", displayName: "Kay")]
            : [SpaceMember(userID: demoUser, displayName: "You")]
    }

    func event(id: String) async throws -> CalendarEvent {
        try await pause()
        return stored[try index(id)].event
    }

    func create(space: SpaceSummary, event: NewEvent) async throws -> CalendarEvent {
        try await pause()
        var created = CalendarEvent(id: UUID().uuidString, spaceID: space.id, title: event.title, location: event.location, body: event.body, zone: event.zone)
        Self.apply(event.timing, to: &created)
        stored.append(Stored(event: created, canEdit: true, attendees: []))
        return created
    }

    nonisolated private static func apply(_ timing: EventTiming, to event: inout CalendarEvent) {
        switch timing {
        case .allDay(let start, let end):
            event.allDay = true
            event.startDate = start
            event.endDate = end
            event.startAt = nil
            event.endAt = nil
        case .timed(let start, let end):
            event.allDay = false
            event.startDate = nil
            event.endDate = nil
            event.startAt = start
            event.endAt = end
        }
    }

    nonisolated private static func apply(_ patch: EventPatch, to event: inout CalendarEvent) {
        if let title = patch.title { event.title = title }
        if let location = patch.location { event.location = location }
        if let body = patch.body { event.body = body }
        if let timing = patch.timing { apply(timing, to: &event) }
    }

    func update(id: String, revision: Int, scope: RecurrenceScope, occurrenceStart: Int64?, patch: EventPatch) async throws -> CalendarEvent {
        try await pause()
        let at = try index(id)
        guard stored[at].event.revision == revision else { throw ApiError.unknown(status: 409) }
        guard stored[at].canEdit else { throw ApiError.unknown(status: 403) }
        if scope == .this, let occurrenceStart {
            let start = Date(timeIntervalSince1970: Double(occurrenceStart) / 1000)
            var single = overrides[key(id, occurrenceStart)] ?? stored[at].event
            if overrides[key(id, occurrenceStart)] == nil {
                let length = (single.endAt ?? start).timeIntervalSince(single.startAt ?? start)
                single.startAt = start
                single.endAt = start.addingTimeInterval(length)
            }
            Self.apply(patch, to: &single)
            overrides[key(id, occurrenceStart)] = single
        } else {
            Self.apply(patch, to: &stored[at].event)
        }
        stored[at].event.revision += 1
        return stored[at].event
    }

    func cancel(id: String, scope: RecurrenceScope, occurrenceStart: Int64?) async throws {
        try await pause()
        let at = try index(id)
        switch scope {
        case .this:
            if let occurrenceStart { removed.insert(key(id, occurrenceStart)) }
        case .thisAndFollowing:
            if let occurrenceStart { endsBefore[id] = Date(timeIntervalSince1970: Double(occurrenceStart) / 1000) }
        case .series:
            stored[at].event.status = .cancelled
        }
    }

    func attendees(eventID: String) async throws -> [EventAttendee] {
        try await pause()
        return stored[try index(eventID)].attendees
    }

    func addAttendee(eventID: String, userID: String) async throws {
        stored[try index(eventID)].attendees.append(EventAttendee(userID: userID))
    }

    func removeAttendee(eventID: String, userID: String) async throws {
        stored[try index(eventID)].attendees.removeAll { $0.userID == userID }
    }

    func setResponse(eventID: String, response: AttendeeResponse) async throws -> EventAttendee {
        let at = try index(eventID)
        guard let mine = stored[at].attendees.firstIndex(where: { $0.userID == demoUser }) else { throw ApiError.unknown(status: 403) }
        stored[at].attendees[mine].response = response
        return stored[at].attendees[mine]
    }
}
