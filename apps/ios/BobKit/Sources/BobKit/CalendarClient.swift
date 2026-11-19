import Foundation

public enum AttendeeResponse: String, Codable, CaseIterable, Sendable {
    case needsAction = "needs_action"
    case accepted, tentative, declined

    public var label: String {
        switch self {
        case .needsAction: "Invited"
        case .accepted: "Going"
        case .tentative: "Maybe"
        case .declined: "Not going"
        }
    }
}

// Which dates an edit or a delete reaches. The server refuses thisAndFollowing on an edit; only a delete may use it.
public enum RecurrenceScope: String, Sendable {
    case this
    case thisAndFollowing = "this_and_following"
    case series
}

// An all-day event carries dates and a timed one carries instants; neither is ever made up from the other.
public enum EventTiming: Equatable, Sendable {
    // endDate is the day after the last day.
    case allDay(startDate: String, endDate: String)
    case timed(start: Date, end: Date)

    var json: [String: Any] {
        switch self {
        case .allDay(let startDate, let endDate):
            ["all_day": true, "start_date": startDate, "end_date": endDate]
        case .timed(let start, let end):
            ["all_day": false, "start_at": AgendaClient.epochMilliseconds(start), "end_at": AgendaClient.epochMilliseconds(end)]
        }
    }
}

public struct CalendarSummary: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
}

// The series definition from GET /api/events/:id. The agenda's rows are its occurrences.
public struct CalendarEvent: Decodable, Equatable, Sendable, Identifiable {
    public enum Status: String, Decodable, Sendable {
        case confirmed, cancelled
    }

    public let id: String
    public let spaceID: String
    public var title: String
    public var location: String?
    public var body: String?
    public var allDay: Bool
    public var startDate: String?
    public var endDate: String?
    public var startAt: Date?
    public var endAt: Date?
    public var zone: String
    // Events share the reminders' rule shape, without the hourly choice.
    public var rule: ReminderRule?
    public var status: Status
    public var revision: Int

    public init(id: String, spaceID: String, title: String, location: String? = nil, body: String? = nil, allDay: Bool = false, startDate: String? = nil, endDate: String? = nil, startAt: Date? = nil, endAt: Date? = nil, zone: String, rule: ReminderRule? = nil, status: Status = .confirmed, revision: Int = 1) {
        self.id = id
        self.spaceID = spaceID
        self.title = title
        self.location = location
        self.body = body
        self.allDay = allDay
        self.startDate = startDate
        self.endDate = endDate
        self.startAt = startAt
        self.endAt = endAt
        self.zone = zone
        self.rule = rule
        self.status = status
        self.revision = revision
    }

    enum CodingKeys: String, CodingKey {
        case id, title, location, body, zone, status, revision
        case spaceID = "space_id"
        case allDay = "all_day"
        case startDate = "start_date"
        case endDate = "end_date"
        case startAt = "start_at"
        case endAt = "end_at"
        case rule = "rrule"
    }
}

public struct NewEvent: Equatable, Sendable {
    public var title: String
    public var location: String?
    public var body: String?
    public var zone: String
    public var timing: EventTiming

    public init(title: String, location: String? = nil, body: String? = nil, zone: String, timing: EventTiming) {
        self.title = title
        self.location = location
        self.body = body
        self.zone = zone
        self.timing = timing
    }
}

// What an edit changes. For the double optionals, nil leaves the field alone and .some(nil) clears it.
public struct EventPatch: Equatable, Sendable {
    public var title: String?
    public var location: String??
    public var body: String??
    public var timing: EventTiming?

    public init(title: String? = nil, location: String?? = nil, body: String?? = nil, timing: EventTiming? = nil) {
        self.title = title
        self.location = location
        self.body = body
        self.timing = timing
    }

    public var isEmpty: Bool { title == nil && location == nil && body == nil && timing == nil }

    var json: [String: Any] {
        var json = timing?.json ?? [:]
        if let title { json["title"] = title }
        if let location { json["location"] = location ?? NSNull() }
        if let body { json["body"] = body ?? NSNull() }
        return json
    }
}

public struct EventAttendee: Decodable, Equatable, Sendable {
    public let userID: String?
    public let email: String?
    public var response: AttendeeResponse

    public init(userID: String?, email: String? = nil, response: AttendeeResponse = .needsAction) {
        self.userID = userID
        self.email = email
        self.response = response
    }

    enum CodingKeys: String, CodingKey {
        case email, response
        case userID = "user_id"
    }
}

// Native calendars, their events and who is invited. GET /api/events is the account's event stream, so events are read through the agenda.
public struct CalendarClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = .shared, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func calendars(spaceID: String) async throws -> [CalendarSummary] {
        let response: CalendarsResponse = try await http.decoded("GET", ["spaces", spaceID, "calendars"])
        return response.calendars
    }

    // The space's first calendar, or a new one when it has none, named as the web names it.
    public func defaultCalendarID(space: SpaceSummary, zone: String) async throws -> String {
        if let first = try await calendars(spaceID: space.id).first { return first.id }
        let created: CalendarSummary = try await http.decoded("POST", ["spaces", space.id, "calendars"], body: [
            "name": space.kind == .private ? "Private" : "Family",
            "zone": String(zone.prefix(64))
        ])
        return created.id
    }

    public func event(id: String) async throws -> CalendarEvent {
        try await http.decoded("GET", ["events", id])
    }

    public func create(calendarID: String, event: NewEvent) async throws -> CalendarEvent {
        var body = event.timing.json
        body["title"] = event.title
        body["zone"] = event.zone
        body["location"] = event.location ?? NSNull()
        body["body"] = event.body ?? NSNull()
        return try await http.decoded("POST", ["calendars", calendarID, "events"], body: body)
    }

    // A stale revision answers 409 with no revision to retry on, so it arrives as ApiError.unknown(status: 409).
    public func update(id: String, revision: Int, scope: RecurrenceScope, occurrenceStart: Int64?, patch: EventPatch) async throws -> CalendarEvent {
        var body = try Self.scoped(scope, occurrenceStart)
        body["revision"] = revision
        body["patch"] = patch.json
        return try await http.decoded("PATCH", ["events", id], body: body)
    }

    public func cancel(id: String, scope: RecurrenceScope, occurrenceStart: Int64?) async throws -> CalendarEvent {
        try await http.decoded("DELETE", ["events", id], body: try Self.scoped(scope, occurrenceStart))
    }

    public func attendees(eventID: String) async throws -> [EventAttendee] {
        let response: AttendeesResponse = try await http.decoded("GET", ["events", eventID, "attendees"])
        return response.attendees
    }

    public func addAttendee(eventID: String, userID: String) async throws -> EventAttendee {
        try await http.decoded("POST", ["events", eventID, "attendees"], body: ["user_id": userID, "role": "required"])
    }

    public func removeAttendee(eventID: String, userID: String) async throws {
        try await http.empty("DELETE", ["events", eventID, "attendees"], query: [URLQueryItem(name: "user_id", value: userID)])
    }

    public func setResponse(eventID: String, response: AttendeeResponse) async throws -> EventAttendee {
        try await http.decoded("PUT", ["events", eventID, "rsvp"], body: ["response": response.rawValue])
    }

    private static func scoped(_ scope: RecurrenceScope, _ occurrenceStart: Int64?) throws -> [String: Any] {
        guard scope != .series else { return ["scope": scope.rawValue] }
        guard let occurrenceStart else { throw ApiError.invalidRequest }
        return ["scope": scope.rawValue, "occurrence_start": occurrenceStart]
    }
}

private struct CalendarsResponse: Decodable {
    let calendars: [CalendarSummary]
}

private struct AttendeesResponse: Decodable {
    let attendees: [EventAttendee]
}
