import Foundation
import Observation

public enum TimelineKind: String, CaseIterable, Codable, Sendable {
    case all, routine, conversation, task, note, event

    public var title: String {
        switch self {
        case .all: "Everything"
        case .routine: "Routine runs"
        case .conversation: "Conversations"
        case .task: "Tasks"
        case .note: "Notes"
        case .event: "Events"
        }
    }

    public var symbol: String {
        switch self {
        case .all: "clock"
        case .routine: "repeat"
        case .conversation: "bubble.left"
        case .task: "checkmark.circle"
        case .note: "note.text"
        case .event: "calendar"
        }
    }
}

public struct TimelineQuery: Equatable, Hashable, Sendable {
    public let day: String
    public let timeZone: String
    public let kind: TimelineKind

    public init(day: String, timeZone: String, kind: TimelineKind = .all) {
        self.day = day
        self.timeZone = timeZone
        self.kind = kind
    }
}

public struct TimelineCursor: Decodable, Equatable, Sendable {
    public let before: Int64
    public let beforeID: String

    public init(before: Int64, beforeID: String) {
        self.before = before
        self.beforeID = beforeID
    }

    enum CodingKeys: String, CodingKey { case before; case beforeID = "beforeId" }
}

public struct TimelineEntry: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: TimelineKind
    public let action: String
    public let title: String
    public let at: Date
    public let recordID: String
    public let spaceID: String?
    public let routineID: String?
    public let status: String?
    public let count: Int

    enum CodingKeys: String, CodingKey {
        case id, kind, action, title, at, status, count
        case recordID = "recordId", spaceID = "spaceId", routineID = "routineId"
    }
}

public struct TimelinePage: Decodable, Equatable, Sendable {
    public let day: String
    public let timeZone: String
    public let entries: [TimelineEntry]
    public let nextCursor: TimelineCursor?

    public init(day: String, timeZone: String, entries: [TimelineEntry], nextCursor: TimelineCursor?) {
        self.day = day
        self.timeZone = timeZone
        self.entries = entries
        self.nextCursor = nextCursor
    }

    public func appending(_ page: TimelinePage) -> TimelinePage {
        guard day == page.day, timeZone == page.timeZone else { return self }
        var seen = Set(entries.map(\.id))
        let additional = page.entries.filter { seen.insert($0.id).inserted }
        return TimelinePage(day: day, timeZone: timeZone, entries: entries + additional,
                            nextCursor: page.nextCursor == nextCursor ? nil : page.nextCursor)
    }
}

public struct TimelineClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func recap(routineID: String, runID: String) async throws -> TimelineRecap {
        guard UUID(uuidString: routineID) != nil, UUID(uuidString: runID) != nil else { throw ApiError.invalidRequest }
        let response: TimelineRecapResponse = try await http.decoded("GET", ["routines", routineID, "runs", runID])
        return response.run
    }

    public func list(query: TimelineQuery, cursor: TimelineCursor? = nil) async throws -> TimelinePage {
        var items = [URLQueryItem(name: "day", value: query.day), URLQueryItem(name: "timeZone", value: query.timeZone),
                     URLQueryItem(name: "kind", value: query.kind.rawValue), URLQueryItem(name: "limit", value: "30")]
        if let cursor {
            items += [URLQueryItem(name: "before", value: String(cursor.before)), URLQueryItem(name: "beforeId", value: cursor.beforeID)]
        }
        return try await http.decoded("GET", ["timeline"], query: items)
    }
}

public struct TimelineRecap: Decodable, Sendable {
    public struct Result: Decodable, Sendable {
        public let title: String
        public let summary: String
        public let sources: [InsightSource]
        public let partial: Bool
    }
    public let id: String
    public let status: String
    public let result: Result?
}

private struct TimelineRecapResponse: Decodable {
    let run: TimelineRecap
}

@MainActor @Observable public final class TimelineFeed {
    public var date = Date()
    public var kind: TimelineKind = .all
    public let timeZone: String
    public private(set) var page: TimelinePage?
    public private(set) var phase: InsightLoadPhase = .loading
    public private(set) var moreBusy = false
    public private(set) var moreError: ApiError?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var loadedQuery: TimelineQuery?
    @ObservationIgnored private let read: @Sendable (TimelineQuery, TimelineCursor?) async throws -> TimelinePage

    public init(timeZone: String = TimeZone.current.identifier, read: @escaping @Sendable (TimelineQuery, TimelineCursor?) async throws -> TimelinePage) {
        self.timeZone = timeZone
        self.read = read
    }

    public var query: TimelineQuery {
        TimelineQuery(day: WallClock.day(date, zone: timeZone), timeZone: timeZone, kind: kind)
    }

    public func refresh() async {
        generation += 1
        let request = generation
        let query = query
        page = nil
        loadedQuery = nil
        phase = .loading
        moreBusy = false
        moreError = nil
        do {
            let page = try await read(query, nil)
            guard request == generation, query == self.query, !Task.isCancelled else { return }
            self.page = page
            loadedQuery = query
            phase = .loaded
        } catch {
            guard request == generation, query == self.query, !(error is CancellationError), (error as? ApiError) != .cancelled, !Task.isCancelled else { return }
            phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }

    public func more() async {
        guard !moreBusy, loadedQuery == query, let page, let cursor = page.nextCursor else { return }
        let request = generation
        let query = query
        moreBusy = true
        moreError = nil
        defer { if request == generation { moreBusy = false } }
        do {
            let next = try await read(query, cursor)
            guard request == generation, query == self.query, !Task.isCancelled else { return }
            self.page = page.appending(next)
        } catch {
            guard request == generation, query == self.query, !(error is CancellationError), (error as? ApiError) != .cancelled, !Task.isCancelled else { return }
            moreError = (error as? ApiError) ?? .unknown(status: 0)
        }
    }

    public func shiftDay(_ offset: Int) {
        date = WallClock.calendar(zone: timeZone).date(byAdding: .day, value: offset, to: date) ?? date
    }

    public func cancel() { generation += 1 }
}

