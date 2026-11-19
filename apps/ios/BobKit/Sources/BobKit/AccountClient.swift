import Foundation

public enum UsageRange: String, CaseIterable, Identifiable, Sendable {
    case week = "7d", month = "30d", quarter = "90d"

    public var id: String { rawValue }

    public var days: Int {
        switch self {
        case .week: 7
        case .month: 30
        case .quarter: 90
        }
    }

    public var title: String { "\(days) days" }
}

public struct UsageSurfaceCounts: Decodable, Equatable, Sendable {
    public let device: Int
    public let voice: Int
    public let typed: Int

    public init(device: Int, voice: Int, typed: Int) {
        self.device = device
        self.voice = voice
        self.typed = typed
    }

    enum CodingKeys: String, CodingKey {
        case device
        case voice = "web_voice"
        case typed = "web_text"
    }
}

public struct UsageDay: Decodable, Equatable, Sendable, Identifiable {
    public let day: String
    public let counts: UsageSurfaceCounts

    public var id: String { day }

    public init(day: String, counts: UsageSurfaceCounts) {
        self.day = day
        self.counts = counts
    }

    enum CodingKeys: String, CodingKey { case day }

    public init(from decoder: Decoder) throws {
        day = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .day)
        counts = try UsageSurfaceCounts(from: decoder)
    }
}

public struct UsageWeekdayHour: Decodable, Equatable, Sendable {
    public let hour: Int
    public let count: Int

    public init(hour: Int, count: Int) {
        self.hour = hour
        self.count = count
    }
}

// Counts and times only, never what was said. Days and hours are in the account's time zone.
public struct UsageReport: Decodable, Equatable, Sendable {
    public struct Turns: Decodable, Equatable, Sendable {
        public let total: Int
        public let bySurface: UsageSurfaceCounts
        public let byDay: [UsageDay]
        public let byWeekdayHour: [UsageWeekdayHour]

        public init(total: Int, bySurface: UsageSurfaceCounts, byDay: [UsageDay], byWeekdayHour: [UsageWeekdayHour]) {
            self.total = total
            self.bySurface = bySurface
            self.byDay = byDay
            self.byWeekdayHour = byWeekdayHour
        }

        enum CodingKeys: String, CodingKey {
            case total
            case bySurface = "by_surface"
            case byDay = "by_day"
            case byWeekdayHour = "by_weekday_hour"
        }
    }

    public struct Created: Decodable, Equatable, Sendable {
        public let tasks: Int
        public let notes: Int
        public let reminders: Int

        public init(tasks: Int, notes: Int, reminders: Int) {
            self.tasks = tasks
            self.notes = notes
            self.reminders = reminders
        }
    }

    public struct Memories: Decodable, Equatable, Sendable {
        public let newInRange: Int
        public let total: Int

        public init(newInRange: Int, total: Int) {
            self.newInRange = newInRange
            self.total = total
        }

        enum CodingKeys: String, CodingKey {
            case total
            case newInRange = "new_in_range"
        }
    }

    public let activeDays: Int
    public let turns: Turns
    public let conversationsCreated: Int
    public let created: Created
    public let todosDone: Int
    public let memories: Memories?
    public let gameMinutes: Int?

    public init(activeDays: Int, turns: Turns, conversationsCreated: Int, created: Created, todosDone: Int, memories: Memories?, gameMinutes: Int?) {
        self.activeDays = activeDays
        self.turns = turns
        self.conversationsCreated = conversationsCreated
        self.created = created
        self.todosDone = todosDone
        self.memories = memories
        self.gameMinutes = gameMinutes
    }

    enum CodingKeys: String, CodingKey {
        case turns, created, memories
        case activeDays = "active_days"
        case conversationsCreated = "conversations_created"
        case todosDone = "todos_done"
        case gameMinutes = "game_minutes"
    }
}

public enum UsageRules {
    public static func hasNoActivity(_ usage: UsageReport) -> Bool {
        let created = usage.created.tasks + usage.created.notes + usage.created.reminders + (usage.memories?.newInRange ?? 0)
        return usage.turns.total == 0 && usage.todosDone == 0 && created == 0
    }

    // The account-zone hour with the most messages; the earliest listed wins a tie, as on the web.
    public static func busiestHour(_ cells: [UsageWeekdayHour]) -> Int? {
        var order: [Int] = []
        var totals: [Int: Int] = [:]
        for cell in cells {
            if totals[cell.hour] == nil { order.append(cell.hour) }
            totals[cell.hour, default: 0] += cell.count
        }
        var best: Int?
        for hour in order where best == nil || totals[hour, default: 0] > totals[best ?? hour, default: 0] {
            best = hour
        }
        return best
    }

    // The hour and day are already the account's, so they are formatted as they stand, in UTC.
    public static func hourLabel(_ hour: Int, locale: Locale = .current) -> String {
        let formatter = utcFormatter(template: "j", locale: locale)
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(hour) * 3600))
    }

    public static func busiestSentence(_ usage: UsageReport, locale: Locale = .current) -> String? {
        busiestHour(usage.turns.byWeekdayHour).map { "You talk to Bob most around \(hourLabel($0, locale: locale))." }
    }

    // A YYYY-MM-DD as an instant at its UTC midnight.
    public static func date(ofDay day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func utcFormatter(template: String, locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
}

// The person's own data as a file, held in memory until they choose where it goes.
public struct AccountExport: Equatable, Sendable {
    public let data: Data
    public let fileName: String

    public init(data: Data, fileName: String) {
        self.data = data
        self.fileName = fileName
    }

    // The save panel adds the extension itself.
    public var baseName: String {
        fileName.hasSuffix(".json") ? String(fileName.dropLast(5)) : fileName
    }
}

// The account routes. Nothing here touches disk: the default session has no cache at all.
public struct AccountClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func usage(_ range: UsageRange) async throws -> UsageReport {
        try await http.decoded("GET", ["me", "usage"], query: [URLQueryItem(name: "range", value: range.rawValue)])
    }

    // Limited to one a minute: a second one is ApiError.rateLimited.
    public func export() async throws -> AccountExport {
        let file = try await http.file(["account", "export"])
        return AccountExport(data: file.data, fileName: Self.fileName(disposition: file.disposition))
    }

    // Refused with ApiError.ownsGroups while the person owns shared spaces. Safe to retry after a failure.
    public func deleteAccount() async throws {
        try await http.empty("DELETE", ["account"], body: ["confirm": true])
    }

    static func fileName(disposition: String?) -> String {
        guard let disposition, let match = try? /filename="([^"\/\\]+)"/.firstMatch(in: disposition) else {
            return "bob-export.json"
        }
        return String(match.1)
    }
}

// Who is signed in, read from the signed session token. For showing only: the server checks the token, this does not.
public struct AccountProfile: Equatable, Sendable {
    public static let nameLimit = 60

    public var email: String?
    public var name: String?
    public var timeZone: String?

    public init(email: String? = nil, name: String? = nil, timeZone: String? = nil) {
        self.email = email
        self.name = name
        self.timeZone = timeZone
    }

    // Nil for anything that isn't a readable token. A name is never made up from the email.
    public init?(accessToken: String) {
        let parts = accessToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let metadata = claims["user_metadata"] as? [String: Any]
        func text(_ value: Any?) -> String? {
            guard let trimmed = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
            return trimmed
        }
        email = text(claims["email"])
        name = text(metadata?["name"]) ?? text(metadata?["full_name"])
        timeZone = text(metadata?["time_zone"])
    }

    // The name to save, or nil when it is empty or too long.
    public static func validName(_ draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.count > nameLimit ? nil : trimmed
    }

    public static func zoneLabel(_ zone: String) -> String {
        zone.replacingOccurrences(of: "_", with: " ")
    }

    // Every zone this phone knows, plus UTC, with a search over what a person reads.
    public static func zones(matching query: String, known: [String] = TimeZone.knownTimeZoneIdentifiers) -> [String] {
        let all = known.contains("UTC") ? known : ["UTC"] + known
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? all : all.filter { zoneLabel($0).localizedCaseInsensitiveContains(text) }
    }
}

// The typed confirmation before an account is deleted.
public enum AccountDeletion {
    public static func phrase(email: String?) -> String {
        email ?? "delete my account"
    }

    public static func isConfirmed(typed: String, email: String?) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == phrase(email: email).lowercased()
    }
}
