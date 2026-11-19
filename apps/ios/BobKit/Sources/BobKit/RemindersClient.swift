import Foundation

// The server's rule shape. Key names match the wire, including the camel-case byWeekday (0 is Sunday).
public struct ReminderRule: Codable, Equatable, Hashable, Sendable {
    public enum Frequency: String, Codable, Sendable {
        case hourly, daily, weekly, monthly, yearly
    }

    public struct Window: Codable, Equatable, Hashable, Sendable {
        public var start: String
        public var end: String

        public init(start: String, end: String) {
            self.start = start
            self.end = end
        }
    }

    public var freq: Frequency
    public var interval: Int?
    public var byWeekday: [Int]?
    public var window: Window?
    public var until: String?
    public var count: Int?

    public init(freq: Frequency, interval: Int? = nil, byWeekday: [Int]? = nil, window: Window? = nil, until: String? = nil, count: Int? = nil) {
        self.freq = freq
        self.interval = interval
        self.byWeekday = byWeekday
        self.window = window
        self.until = until
        self.count = count
    }

    fileprivate func jsonString() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let text = String(data: try encoder.encode(self), encoding: .utf8) else {
            throw ApiError.invalidRequest
        }
        return text
    }

    fileprivate func json() throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(self))
    }
}

public struct Reminder: Decodable, Equatable, Sendable, Identifiable {
    public enum Status: String, Decodable, Sendable {
        case active, paused, cancelled
    }

    public let id: String
    public let spaceID: String
    public var title: String
    public var dueAt: Date?
    public var dueZone: String?
    public var rule: ReminderRule?
    public var scheduleRevision: Int
    public var status: Status
    // Only present where the server reads them back.
    public var recipientUserIDs: [String]?

    public init(id: String, spaceID: String, title: String, dueAt: Date?, dueZone: String?, rule: ReminderRule? = nil, scheduleRevision: Int = 1, status: Status = .active, recipientUserIDs: [String]? = nil) {
        self.id = id
        self.spaceID = spaceID
        self.title = title
        self.dueAt = dueAt
        self.dueZone = dueZone
        self.rule = rule
        self.scheduleRevision = scheduleRevision
        self.status = status
        self.recipientUserIDs = recipientUserIDs
    }

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case recipientUserIDs = "recipient_user_ids"
        case spaceID = "space_id"
        case dueAt = "due_at"
        case dueZone = "due_zone"
        case rule = "rrule"
        case scheduleRevision = "schedule_revision"
    }
}

// What an edit may change. Nil leaves a field alone; a rule of .some(nil) makes the reminder one-off.
public struct ReminderChanges: Equatable, Sendable {
    public var title: String?
    public var due: ReminderDue?
    public var rule: ReminderRule??

    public init(title: String? = nil, due: ReminderDue? = nil, rule: ReminderRule?? = nil) {
        self.title = title
        self.due = due
        self.rule = rule
    }

    public var isEmpty: Bool { title == nil && due == nil && rule == nil }
}

// due_at and due_zone always travel together.
public struct ReminderDue: Equatable, Sendable {
    public var at: Date
    public var zone: String

    public init(at: Date, zone: String) {
        self.at = at
        self.zone = zone
    }
}

public struct ReminderOccurrencePreview: Decodable, Equatable, Sendable {
    public let at: Date
    public let wallTime: String

    public init(at: Date, wallTime: String) {
        self.at = at
        self.wallTime = wallTime
    }

    enum CodingKeys: String, CodingKey {
        case at
        case wallTime = "wall_time"
    }
}

// Reminders in a space, with the server's own preview of the next rings. Reminders carry no edit revision.
public struct RemindersClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = .shared, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // Every status, cancelled included: the server does not filter them.
    public func reminders(spaceID: String) async throws -> [Reminder] {
        let response: RemindersResponse = try await http.decoded("GET", ["spaces", spaceID, "reminders"])
        return response.reminders
    }

    public func create(spaceID: String, title: String, due: ReminderDue, rule: ReminderRule?, recipients: [String]) async throws -> Reminder {
        let body: [String: Any] = [
            "title": title,
            "due_at": AgendaClient.epochMilliseconds(due.at),
            "due_zone": due.zone,
            "rrule": try rule?.json() ?? NSNull(),
            "recipient_user_ids": recipients
        ]
        let response: ReminderResponse = try await http.decoded("POST", ["spaces", spaceID, "reminders"], body: body)
        return response.reminder
    }

    public func update(id: String, changes: ReminderChanges) async throws -> Reminder {
        guard !changes.isEmpty else { throw ApiError.invalidRequest }
        var body: [String: Any] = [:]
        if let title = changes.title { body["title"] = title }
        if let due = changes.due {
            body["due_at"] = AgendaClient.epochMilliseconds(due.at)
            body["due_zone"] = due.zone
        }
        if let rule = changes.rule { body["rrule"] = try rule?.json() ?? NSNull() }
        let response: ReminderResponse = try await http.decoded("PATCH", ["reminders", id], body: body)
        return response.reminder
    }

    public func cancel(id: String) async throws -> Reminder {
        let response: ReminderResponse = try await http.decoded("POST", ["reminders", id, "cancel"])
        return response.reminder
    }

    // What the web's Snooze does for a one-off: moves it later. A repeating reminder has no such move, because every later ring would shift too.
    public func snooze(_ reminder: Reminder, until: Date, fallbackZone: String) async throws -> Reminder {
        guard reminder.rule == nil else { throw ApiError.invalidRequest }
        return try await update(id: reminder.id, changes: ReminderChanges(due: ReminderDue(at: until, zone: reminder.dueZone ?? fallbackZone)))
    }

    // Snoozes the caller's own ring of a reminder. The occurrence id comes from the notification that rang.
    public func snoozeOccurrence(reminderID: String, occurrenceID: String, until: Date) async throws {
        try await http.empty("POST", ["reminders", reminderID, "occurrences", "snooze"], body: [
            "occurrence_id": occurrenceID,
            "until": AgendaClient.epochMilliseconds(until)
        ])
    }

    public func preview(due: ReminderDue, rule: ReminderRule?) async throws -> [ReminderOccurrencePreview] {
        var query = [
            URLQueryItem(name: "due", value: String(AgendaClient.epochMilliseconds(due.at))),
            URLQueryItem(name: "zone", value: due.zone)
        ]
        if let rule {
            query.append(URLQueryItem(name: "rrule", value: try rule.jsonString()))
        }
        let response: PreviewResponse = try await http.decoded("GET", ["reminders", "preview"], query: query)
        return response.occurrences
    }
}

private struct RemindersResponse: Decodable {
    let reminders: [Reminder]
}

private struct ReminderResponse: Decodable {
    let reminder: Reminder
}

private struct PreviewResponse: Decodable {
    let occurrences: [ReminderOccurrencePreview]
}
