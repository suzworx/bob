import Foundation

public struct Memory: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case fact, preference, intent
        case actionItem = "action_item"
    }

    public struct Source: Decodable, Equatable, Sendable {
        public let conversationID: String?
        public let surface: String

        public init(conversationID: String? = nil, surface: String = "web_text") {
            self.conversationID = conversationID
            self.surface = surface
        }

        enum CodingKeys: String, CodingKey {
            case surface
            case conversationID = "conversation_id"
        }
    }

    public let id: String
    public let kind: Kind
    public var content: String
    public let confidence: Double
    public let sensitive: Bool
    public let source: Source
    public let supersededBy: String?
    public let createdAt: Date
    public let updatedAt: Date

    public init(id: String, kind: Kind, content: String, confidence: Double = 1, sensitive: Bool = false, source: Source = Source(), supersededBy: String? = nil, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.kind = kind
        self.content = content
        self.confidence = confidence
        self.sensitive = sensitive
        self.source = source
        self.supersededBy = supersededBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, content, confidence, sensitive, source
        case supersededBy = "superseded_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct MemoryPage: Equatable, Sendable {
    public let memories: [Memory]
    public let nextCursor: String?

    public init(memories: [Memory], nextCursor: String?) {
        self.memories = memories
        self.nextCursor = nextCursor
    }
}

// The server's list filters; nil asks for no filter.
public struct MemoryQuery: Equatable, Sendable {
    public var text: String?
    public var cursor: String?
    public var kind: Memory.Kind?
    public var sensitive: Bool?
    public var currentOnly: Bool?
    public var limit: Int?

    public init(text: String? = nil, cursor: String? = nil, kind: Memory.Kind? = nil, sensitive: Bool? = nil, currentOnly: Bool? = nil, limit: Int? = nil) {
        self.text = text
        self.cursor = cursor
        self.kind = kind
        self.sensitive = sensitive
        self.currentOnly = currentOnly
        self.limit = limit
    }

    var items: [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        if let kind { items.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        if let sensitive { items.append(URLQueryItem(name: "sensitive", value: String(sensitive))) }
        if let currentOnly { items.append(URLQueryItem(name: "current_only", value: String(currentOnly))) }
        if let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            items.append(URLQueryItem(name: "q", value: String(text.prefix(200))))
        }
        return items
    }
}

// A to-do Bob picked up from a conversation.
public struct ActionItem: Decodable, Equatable, Sendable, Identifiable {
    public enum Status: String, Decodable, Sendable {
        case open, done, dropped
    }

    public let id: String
    public let memoryID: String
    public let content: String
    public let status: Status
    public let dueAt: Date?

    public init(id: String, memoryID: String, content: String, status: Status = .open, dueAt: Date? = nil) {
        self.id = id
        self.memoryID = memoryID
        self.content = content
        self.status = status
        self.dueAt = dueAt
    }

    enum CodingKeys: String, CodingKey {
        case id, content, status
        case memoryID = "memory_id"
        case dueAt = "due_at"
    }
}

// What Bob remembers. Memory is sensitive, so nothing here touches disk: the default session has no cache at all.
public struct MemoryClient: Sendable {
    public static let memoryOnlySession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func memories(_ query: MemoryQuery = MemoryQuery()) async throws -> MemoryPage {
        let response: MemoriesResponse = try await http.decoded("GET", ["memories"], query: query.items)
        return MemoryPage(memories: response.memories, nextCursor: response.next_cursor)
    }

    public func create(content: String, kind: Memory.Kind) async throws -> Memory {
        try await http.decoded("POST", ["memories"], body: ["content": content, "kind": kind.rawValue])
    }

    public func correct(id: String, content: String) async throws -> Memory {
        try await http.decoded("PATCH", ["memories", id], body: ["content": content])
    }

    public func forget(id: String) async throws {
        try await http.empty("DELETE", ["memories", id])
    }

    public func forgetAll() async throws {
        try await http.empty("DELETE", ["memories"])
    }

    public func actionItems() async throws -> [ActionItem] {
        let response: ActionItemsResponse = try await http.decoded("GET", ["action-items"])
        return response.action_items
    }

    public func setStatus(actionItemID: String, status: ActionItem.Status) async throws -> ActionItem {
        try await http.decoded("PATCH", ["action-items", actionItemID], body: ["status": status.rawValue])
    }

    // A copy of the memory as an ordinary task in a space. The title is the person's to give; the server never copies it.
    public func promote(memoryID: String, spaceID: String, title: String, dueAt: Date?) async throws -> TaskItem {
        var body: [String: Any] = ["space_id": spaceID, "title": title]
        if let dueAt { body["due_at"] = AgendaClient.epochMilliseconds(dueAt) }
        return try await http.decoded("POST", ["memories", memoryID, "promote"], body: body)
    }
}

private struct MemoriesResponse: Decodable {
    let memories: [Memory]
    let next_cursor: String?
}

private struct ActionItemsResponse: Decodable {
    let action_items: [ActionItem]
}
