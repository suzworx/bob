import Foundation

// What GET /api/search finds. Chats are found by ConversationsClient.list, which matches their titles.
public struct SearchResult: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable, CaseIterable {
        case task, note, event, thread

        public var groupTitle: String {
            switch self {
            case .task: "Tasks"
            case .note: "Notes"
            case .event: "Events"
            case .thread: "Threads"
            }
        }
    }

    public let kind: Kind
    public let resourceID: String
    public let spaceID: String
    public let title: String
    public let snippet: String
    public let updatedAt: Date

    public var id: String { "\(kind.rawValue):\(resourceID)" }

    public init(kind: Kind, resourceID: String, spaceID: String, title: String, snippet: String = "", updatedAt: Date) {
        self.kind = kind
        self.resourceID = resourceID
        self.spaceID = spaceID
        self.title = title
        self.snippet = snippet
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case kind = "resource_type"
        case resourceID = "resource_id"
        case spaceID = "space_id"
        case title, snippet
        case updatedAt = "updated_at"
    }

    public var displayTitle: String {
        title.isEmpty ? "Untitled" : title
    }
}

public struct SearchClient: Sendable {
    private static let queryLimit = 200

    private let http: JSONRequester

    // What people search for is as private as what they find, so nothing here reaches a URL cache.
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func search(_ query: String, types: [SearchResult.Kind] = [], limit: Int? = nil) async throws -> [SearchResult] {
        let text = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.queryLimit))
        guard !text.isEmpty else {
            return []
        }
        var items = [URLQueryItem(name: "q", value: text)]
        items += types.map { URLQueryItem(name: "type", value: $0.rawValue) }
        if let limit {
            items.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        let response: SearchResponse = try await http.decoded("GET", ["search"], query: items)
        return response.results
    }
}

private struct SearchResponse: Decodable {
    let results: [SearchResult]
}
