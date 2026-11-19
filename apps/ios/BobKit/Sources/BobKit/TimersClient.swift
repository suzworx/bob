import Foundation

public struct TimerSummary: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case timer, alarm }
    public let id: String
    public let kind: Kind
    public let label: String?
    public let firesAt: Date
    public let remainingMilliseconds: Int
    public let zone: String
    public var title: String { label ?? (kind == .timer ? "Timer" : "Alarm") }

    enum CodingKeys: String, CodingKey {
        case id, kind, label, zone
        case firesAt = "fire_at", remainingMilliseconds = "remaining_ms"
    }
    public init(id: String, kind: Kind, label: String?, firesAt: Date, remainingMilliseconds: Int, zone: String) {
        self.id = id; self.kind = kind; self.label = label; self.firesAt = firesAt
        self.remainingMilliseconds = remainingMilliseconds; self.zone = zone
    }
}

/// Authoritative states include only active timers and explicitly tracked OS requests.
public struct TimerNotificationState: Decodable, Equatable, Sendable, Identifiable {
    public enum Status: String, Decodable, Sendable { case pending, fired, cancelled, dismissed }
    public let timer: TimerSummary
    public let status: Status
    public var id: String { timer.id }

    public init(timer: TimerSummary, status: Status) {
        self.timer = timer
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case status }
    public init(from decoder: any Decoder) throws {
        timer = try TimerSummary(from: decoder)
        status = try decoder.container(keyedBy: CodingKeys.self).decode(Status.self, forKey: .status)
    }
}

/// Timers remain owned by Core. Creating a timer or alarm uses Bob's existing tools.
public struct TimersClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func list() async throws -> [TimerSummary] {
        let response: ListResponse = try await http.decoded("GET", ["timers"])
        guard response.timers.allSatisfy({ !$0.id.isEmpty && $0.remainingMilliseconds >= 0 }),
              Set(response.timers.map(\.id)).count == response.timers.count else { throw ApiError.unknown(status: 200) }
        return response.timers
    }
    public func notificationState(trackedIDs: [String]) async throws -> [TimerNotificationState] {
        guard trackedIDs.count <= 60, Set(trackedIDs).count == trackedIDs.count,
              trackedIDs.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw ApiError.invalidRequest }
        let query = trackedIDs.isEmpty ? [] : [URLQueryItem(name: "ids", value: trackedIDs.joined(separator: ","))]
        let response: NotificationStateResponse = try await http.decoded("GET", ["timers", "notification-state"], query: query)
        guard response.timers.count <= 120,
              response.timers.allSatisfy({ UUID(uuidString: $0.id) != nil && $0.timer.remainingMilliseconds >= 0 }),
              Set(response.timers.map(\.id)).count == response.timers.count,
              response.timers.allSatisfy({ $0.status == .pending || trackedIDs.contains($0.id) }) else {
            throw ApiError.unknown(status: 200)
        }
        return response.timers
    }
    public func cancel(id: String) async throws {
        guard UUID(uuidString: id) != nil else { throw ApiError.invalidRequest }
        do {
            let response: CancelResponse = try await http.decoded("DELETE", ["timers", id])
            guard response.cancelled.id == id, response.remaining >= 0 else { throw ApiError.unknown(status: 200) }
        } catch ApiError.notFound {
            // It already fired or was cancelled elsewhere; either way the pending row is gone.
            return
        }
    }
    private struct ListResponse: Decodable { let timers: [TimerSummary] }
    private struct NotificationStateResponse: Decodable { let timers: [TimerNotificationState] }
    private struct CancelResponse: Decodable { let cancelled: TimerSummary; let remaining: Int }
}
