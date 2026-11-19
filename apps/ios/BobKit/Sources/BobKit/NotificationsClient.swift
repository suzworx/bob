import Foundation

// A kind from a newer server decodes as .other, so one new kind can't empty the inbox.
public enum NotificationKind: String, Decodable, CaseIterable, Sendable {
    case mention, assignment, reminder, invitation, security, other
    case eventChange = "event_change"
    case taskUpdate = "task_update"
    case bobMessage = "bob_message"

    public init(from decoder: Decoder) throws {
        self = NotificationKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

// Who did it, to what, where and when, read by the server under the person's own access. Never a message body.
public struct NotificationAbout: Decodable, Equatable, Sendable {
    public let actorName: String?
    public let title: String?
    public let spaceName: String?
    public let at: Date?
    public let date: String?
    public let action: String?

    public init(actorName: String? = nil, title: String? = nil, spaceName: String? = nil, at: Date? = nil, date: String? = nil, action: String? = nil) {
        self.actorName = actorName
        self.title = title
        self.spaceName = spaceName
        self.at = at
        self.date = date
        self.action = action
    }

    enum CodingKeys: String, CodingKey {
        case title, at, date, action
        case actorName = "actor_name"
        case spaceName = "space_name"
    }
}

public struct InboxNotification: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String?
    public let kind: NotificationKind
    public let resourceType: String
    public let resourceID: String
    public let cursor: Int
    public var readAt: Date?
    public let createdAt: Date
    public let about: NotificationAbout?

    public var isUnread: Bool { readAt == nil }

    public init(id: String, spaceID: String? = nil, kind: NotificationKind, resourceType: String = "", resourceID: String = "", cursor: Int, readAt: Date? = nil, createdAt: Date, about: NotificationAbout? = nil) {
        self.id = id
        self.spaceID = spaceID
        self.kind = kind
        self.resourceType = resourceType
        self.resourceID = resourceID
        self.cursor = cursor
        self.readAt = readAt
        self.createdAt = createdAt
        self.about = about
    }

    enum CodingKeys: String, CodingKey {
        case id, cursor, about
        case kind = "type"
        case spaceID = "space_id"
        case resourceType = "resource_type"
        case resourceID = "resource_id"
        case readAt = "read_at"
        case createdAt = "created_at"
    }
}

public struct InboxPage: Decodable, Equatable, Sendable {
    public let notifications: [InboxNotification]
    public let nextCursor: Int?
    public let unreadCount: Int

    public init(notifications: [InboxNotification], nextCursor: Int?, unreadCount: Int) {
        self.notifications = notifications
        self.nextCursor = nextCursor
        self.unreadCount = unreadCount
    }

    enum CodingKeys: String, CodingKey {
        case notifications
        case nextCursor = "next_cursor"
        case unreadCount = "unread_count"
    }
}

public struct NotificationPreference: Decodable, Equatable, Sendable {
    public let spaceID: String?
    public let threadID: String?
    public let kind: NotificationKind?
    public let muted: Bool

    public init(spaceID: String? = nil, threadID: String? = nil, kind: NotificationKind?, muted: Bool) {
        self.spaceID = spaceID
        self.threadID = threadID
        self.kind = kind
        self.muted = muted
    }

    enum CodingKeys: String, CodingKey {
        case muted
        case kind = "type"
        case spaceID = "space_id"
        case threadID = "thread_id"
    }

    // The account-wide switch for one kind, not a space's or a thread's.
    public var isAccountWide: Bool { spaceID == nil && threadID == nil }
}

public struct NotificationsClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func list(limit: Int? = nil, after: Int? = nil, unreadOnly: Bool = false) async throws -> InboxPage {
        var query: [URLQueryItem] = []
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let after { query.append(URLQueryItem(name: "after", value: String(after))) }
        if unreadOnly { query.append(URLQueryItem(name: "unread", value: "true")) }
        return try await http.decoded("GET", ["notifications"], query: query)
    }

    public func markRead(ids: [String]) async throws {
        try await http.empty("PUT", ["notifications", "read"], body: ["ids": ids])
    }

    // Every notification at or below this cursor, loaded or not.
    public func markRead(upToCursor cursor: Int) async throws {
        try await http.empty("PUT", ["notifications", "read"], body: ["up_to_cursor": cursor])
    }

    public func preferences() async throws -> [NotificationPreference] {
        let response: PreferencesResponse = try await http.decoded("GET", ["notification-preferences"])
        return response.preferences
    }

    public func setMuted(_ kind: NotificationKind, muted: Bool) async throws -> NotificationPreference {
        try await http.decoded("PUT", ["notification-preferences"], body: ["type": kind.rawValue, "muted": muted])
    }
}

private struct PreferencesResponse: Decodable {
    let preferences: [NotificationPreference]
}

// Where a notification opens in this app.
public enum NotificationTarget: Equatable, Sendable {
    case task(String), note(String), device(String)
    case thread(id: String, spaceID: String)
    case members(spaceID: String)
    case reminders, calendar, devices
}

public struct NotificationRow: Equatable, Sendable {
    public let label: String
    public let description: String
    public let target: NotificationTarget?

    public init(label: String, description: String, target: NotificationTarget?) {
        self.label = label
        self.description = description
        self.target = target
    }
}

// What one inbox row says and where it goes, worded as on the web.
public enum NotificationRules {
    public struct Setting: Identifiable, Equatable, Sendable {
        public let kind: NotificationKind
        public let label: String
        public let description: String
        public var id: String { kind.rawValue }
    }

    // One switch per kind. Security notices are always on.
    public static let settings: [Setting] = [
        Setting(kind: .reminder, label: "Reminders", description: "When a reminder rings."),
        Setting(kind: .mention, label: "Mentions", description: "When someone mentions you in a conversation."),
        Setting(kind: .assignment, label: "Task assignments", description: "When a task is given to you."),
        Setting(kind: .taskUpdate, label: "Tasks you follow", description: "When one is done, reassigned or its due date moves."),
        Setting(kind: .eventChange, label: "Events", description: "Invites, changes, cancellations and replies."),
        Setting(kind: .invitation, label: "Space members", description: "When someone accepts your invite or joins a space."),
        Setting(kind: .bobMessage, label: "Notes from Bob", description: "When Bob leaves you a note.")
    ]

    public static func isMuted(_ preferences: [NotificationPreference], kind: NotificationKind) -> Bool {
        preferences.contains { $0.isAccountWide && $0.kind == kind && $0.muted }
    }

    public static func unreadLabel(_ unread: Int) -> String {
        unread > 99 ? "99+" : String(unread)
    }

    private static func generic(_ kind: NotificationKind) -> String {
        switch kind {
        case .mention: "You were mentioned"
        case .assignment: "A task was assigned to you"
        case .reminder: "Reminder"
        case .eventChange: "An event changed"
        case .invitation: "Your invitation was accepted"
        case .security: "Security notice"
        case .taskUpdate: "A task you follow changed"
        case .bobMessage: "Bob left you a note"
        case .other: "Something new"
        }
    }

    private static func kindLabel(_ kind: NotificationKind) -> String {
        switch kind {
        case .mention: "Mention"
        case .assignment: "Assigned to you"
        case .reminder: "Reminder"
        case .eventChange: "Event"
        case .invitation: "Space"
        case .security: "Security"
        case .taskUpdate: "Task you follow"
        case .bobMessage: "Note"
        case .other: "Notification"
        }
    }

    private static func join(_ parts: String?...) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // "today 9:00 AM", "tomorrow 9:00 AM", "Oct 4, 9:00 AM"; a date alone is "Oct 22".
    public static func whenLabel(at: Date?, date: String?, zone: String, now: Date, locale: Locale = .current) -> String? {
        if let at {
            let timeZone = TimeZone(identifier: zone) ?? TimeZone(identifier: "UTC") ?? .current
            let time = formatter(template: "jmm", zone: timeZone, locale: locale).string(from: at)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            if calendar.isDate(at, inSameDayAs: now) { return "today \(time)" }
            if calendar.isDate(at, inSameDayAs: now.addingTimeInterval(86400)) { return "tomorrow \(time)" }
            return "\(formatter(template: "MMMd", zone: timeZone, locale: locale).string(from: at)), \(time)"
        }
        if let date, let day = UsageRules.date(ofDay: date) {
            return UsageRules.utcFormatter(template: "MMMd", locale: locale).string(from: day)
        }
        return nil
    }

    private static func formatter(template: String, zone: TimeZone, locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }

    public static func row(_ item: InboxNotification, zone: String, now: Date, locale: Locale = .current) -> NotificationRow {
        guard let about = item.about else {
            let joined = item.kind == .invitation && item.resourceType == "space_member"
            return NotificationRow(label: joined ? "A new member joined" : generic(item.kind), description: kindLabel(item.kind), target: nil)
        }
        let when = whenLabel(at: about.at, date: about.date, zone: zone, now: now, locale: locale)
        let inSpace = item.spaceID != nil
        let actor = about.actorName ?? "Someone"
        switch item.kind {
        case .mention:
            return NotificationRow(label: "\(actor) mentioned you in \(about.title ?? "a conversation")", description: join(about.spaceName), target: item.spaceID.map { .thread(id: item.resourceID, spaceID: $0) })
        case .assignment, .taskUpdate:
            return NotificationRow(
                label: about.title ?? generic(item.kind),
                description: join(kindLabel(item.kind), about.spaceName, when.map { "due \($0)" }),
                target: inSpace ? .task(item.resourceID) : nil
            )
        case .reminder:
            return NotificationRow(label: about.title ?? generic(.reminder), description: join(kindLabel(.reminder), when, about.spaceName), target: .reminders)
        case .eventChange:
            return NotificationRow(label: eventLabel(about, actor: actor), description: join(kindLabel(.eventChange), when, about.spaceName), target: inSpace ? .calendar : nil)
        case .invitation:
            let place = about.spaceName ?? "your space"
            let label = item.resourceType == "space_member" ? "\(actor) joined \(place)" : "\(actor) accepted your invite to \(place)"
            return NotificationRow(label: label, description: kindLabel(.invitation), target: item.spaceID.map { .members(spaceID: $0) })
        case .security:
            return securityRow(item, about)
        case .bobMessage:
            return NotificationRow(
                label: about.title.map { "Bob left you a note: \($0)" } ?? generic(.bobMessage),
                description: join(kindLabel(.bobMessage), about.spaceName),
                target: inSpace ? .note(item.resourceID) : nil
            )
        case .other:
            return NotificationRow(label: about.title ?? generic(.other), description: join(when, about.spaceName), target: nil)
        }
    }

    private static func eventLabel(_ about: NotificationAbout, actor: String) -> String {
        let title = about.title ?? "an event"
        if about.action == "cancelled", about.actorName == nil { return "\(title) was cancelled" }
        let verb: String
        switch about.action {
        case "invited": verb = "invited you to"
        case "cancelled": verb = "cancelled"
        case "accepted": verb = "accepted"
        case "declined": verb = "declined"
        case "tentative": verb = "said maybe to"
        default: verb = "changed"
        }
        return "\(actor) \(verb) \(title)"
    }

    private static func securityRow(_ item: InboxNotification, _ about: NotificationAbout) -> NotificationRow {
        let kind = kindLabel(.security)
        switch about.action {
        case "google_linked":
            return NotificationRow(label: "Google account connected", description: join(kind, about.title), target: nil)
        case "google_unlinked":
            return NotificationRow(label: "Google account removed", description: kind, target: nil)
        case "device_paired":
            return NotificationRow(label: about.title.map { "\($0) was paired" } ?? "A device was paired", description: kind, target: .device(item.resourceID))
        case "device_removed":
            return NotificationRow(label: about.title.map { "\($0) was removed" } ?? "A device was removed", description: kind, target: .devices)
        default:
            return NotificationRow(label: generic(.security), description: kind, target: nil)
        }
    }
}
