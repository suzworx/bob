import BobKit
import Foundation

protocol CalendarService: Sendable {
    func agenda(from: Date, to: Date) async throws -> AgendaPage
    func spaces() async throws -> [SpaceSummary]
    func selfUserID() async throws -> String?
    func tasks(spaceID: String) async throws -> [TaskItem]
    func reminders(spaceID: String) async throws -> [Reminder]
    func members(spaceID: String) async throws -> [SpaceMember]
    func event(id: String) async throws -> CalendarEvent
    func create(space: SpaceSummary, event: NewEvent) async throws -> CalendarEvent
    func update(id: String, revision: Int, scope: RecurrenceScope, occurrenceStart: Int64?, patch: EventPatch) async throws -> CalendarEvent
    func cancel(id: String, scope: RecurrenceScope, occurrenceStart: Int64?) async throws
    func attendees(eventID: String) async throws -> [EventAttendee]
    func addAttendee(eventID: String, userID: String) async throws
    func removeAttendee(eventID: String, userID: String) async throws
    func setResponse(eventID: String, response: AttendeeResponse) async throws -> EventAttendee
}

struct LiveCalendarService: CalendarService {
    let client: CalendarClient
    let agenda: AgendaClient
    let spaces: SpacesClient
    let tasks: TasksClient
    let reminders: RemindersClient
    let space: PrivateSpace

    func agenda(from: Date, to: Date) async throws -> AgendaPage { try await agenda.page(from: from, to: to) }
    func spaces() async throws -> [SpaceSummary] { try await spaces.spaces() }

    // A private space has one member: the person.
    func selfUserID() async throws -> String? {
        let members = try await space.members()
        return members.count == 1 ? members[0] : nil
    }

    func tasks(spaceID: String) async throws -> [TaskItem] { try await tasks.tasks(spaceID: spaceID) }
    func reminders(spaceID: String) async throws -> [Reminder] { try await reminders.reminders(spaceID: spaceID) }
    func members(spaceID: String) async throws -> [SpaceMember] { try await spaces.members(spaceID: spaceID) }
    func event(id: String) async throws -> CalendarEvent { try await client.event(id: id) }

    func create(space: SpaceSummary, event: NewEvent) async throws -> CalendarEvent {
        let calendarID = try await client.defaultCalendarID(space: space, zone: event.zone)
        return try await client.create(calendarID: calendarID, event: event)
    }

    func update(id: String, revision: Int, scope: RecurrenceScope, occurrenceStart: Int64?, patch: EventPatch) async throws -> CalendarEvent {
        try await client.update(id: id, revision: revision, scope: scope, occurrenceStart: occurrenceStart, patch: patch)
    }

    func cancel(id: String, scope: RecurrenceScope, occurrenceStart: Int64?) async throws {
        _ = try await client.cancel(id: id, scope: scope, occurrenceStart: occurrenceStart)
    }

    func attendees(eventID: String) async throws -> [EventAttendee] { try await client.attendees(eventID: eventID) }
    func addAttendee(eventID: String, userID: String) async throws { _ = try await client.addAttendee(eventID: eventID, userID: userID) }
    func removeAttendee(eventID: String, userID: String) async throws { try await client.removeAttendee(eventID: eventID, userID: userID) }
    func setResponse(eventID: String, response: AttendeeResponse) async throws -> EventAttendee {
        try await client.setResponse(eventID: eventID, response: response)
    }
}
