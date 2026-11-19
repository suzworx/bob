import Foundation

// One row of the chat list.
public struct ConversationSummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public var title: String
    public let createdAt: Date
    public var updatedAt: Date
    public var pinned: Bool
    public var archived: Bool

    public init(id: String, title: String, createdAt: Date, updatedAt: Date, pinned: Bool = false, archived: Bool = false) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pinned = pinned
        self.archived = archived
    }

    public var displayTitle: String {
        // A title can start from a message holding a mention token: show the service, never the account behind it.
        let readable = title.replacing(/@\{[^:}]+:([^:.}]+)[^}]*(?:\}|$)/) { "@\($0.output.1)" }
        let trimmed = readable.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled chat" : trimmed
    }

    enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, pinned, archived
    }

    // A database that has not had the flags migration leaves them out.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    }
}

// One stored piece of a message. The server's parts are open-ended, so only what is shown is kept. A tool's input and output never are.
public enum ConversationPart: Decodable, Equatable, Sendable {
    case text(String)
    case reasoning(String)
    case tool(ChatToolActivity)
    case file(ChatAttachment)
    case other

    enum CodingKeys: String, CodingKey {
        case type, text, filename, mediaType, url, toolCallId, toolName, state
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""
        func string(_ key: CodingKeys) -> String? { try? container.decode(String.self, forKey: key) }
        switch type {
        case "text":
            self = string(.text).map(Self.text) ?? .other
        case "reasoning":
            self = string(.text).map(Self.reasoning) ?? .other
        case "file":
            self = .file(ChatAttachment(name: string(.filename), mediaType: string(.mediaType), url: string(.url)))
        default:
            // The AI SDK stores a tool as `tool-<name>`, or `dynamic-tool` with the name alongside.
            let name = type == "dynamic-tool" ? string(.toolName) : type.hasPrefix("tool-") ? String(type.dropFirst(5)) : nil
            guard let name, let id = string(.toolCallId) else {
                self = .other
                return
            }
            self = .tool(ChatToolActivity(id: id, toolName: name, status: ChatToolActivity.Status(storedState: string(.state))))
        }
    }
}

public struct ConversationMessageVersion: Decodable, Equatable, Sendable {
    public let id: String
    public let parts: [ConversationPart]
    public let versionIndex: Int
    public let selected: Bool

    public init(id: String, parts: [ConversationPart], versionIndex: Int = 0, selected: Bool = true) {
        self.id = id
        self.parts = parts
        self.versionIndex = versionIndex
        self.selected = selected
    }
}

public struct ConversationMessage: Decodable, Equatable, Sendable, Identifiable {
    public enum Role: String, Decodable, Sendable {
        case user, assistant
    }

    public let id: String
    public let role: Role
    public let position: Int
    public let origin: String
    public let createdAt: Date
    public let versions: [ConversationMessageVersion]

    public init(id: String, role: Role, position: Int, origin: String = "web_text", createdAt: Date, versions: [ConversationMessageVersion]) {
        self.id = id
        self.role = role
        self.position = position
        self.origin = origin
        self.createdAt = createdAt
        self.versions = versions
    }

    // The selected version, else the first, as the web shows it.
    public var parts: [ConversationPart] {
        (versions.first { $0.selected } ?? versions.first)?.parts ?? []
    }

    public var text: String {
        parts.compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }.joined(separator: "\n\n")
    }

    public var attachments: [ChatAttachment] {
        parts.compactMap { part in
            if case .file(let attachment) = part { return attachment }
            return nil
        }
    }

    // The same words the web uses. The server has no origin for a typed message worth saying.
    public var originNote: String? {
        switch origin {
        case "device": "via your device"
        case "web_voice": "spoken"
        default: nil
        }
    }
}

public struct ConversationDetail: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let createdAt: Date
    public let updatedAt: Date
    public let messages: [ConversationMessage]

    public init(id: String, title: String, createdAt: Date, updatedAt: Date, messages: [ConversationMessage]) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messages = messages
    }
}

// The person's one-to-one chats: the list, one chat with its messages, and every change the web can make to them.
public struct ConversationsClient: Sendable {
    public static let titleLimit = 200
    private static let queryLimit = 200
    // Four attachments of 4 MB per message come back inline as base64, so a chat can be far larger than a list of notes.
    private static let maxBodyBytes = 64 * 1_048_576

    private let http: JSONRequester

    // Conversation text never reaches a URL cache.
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate, maxBodyBytes: Self.maxBodyBytes)
    }

    // The server returns the newest 200, pinned first, and matches a query against titles only.
    public func list(query: String? = nil, archived: Bool = false) async throws -> [ConversationSummary] {
        var items: [URLQueryItem] = []
        if let text = query?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            items.append(URLQueryItem(name: "q", value: String(text.prefix(Self.queryLimit))))
        }
        if archived {
            items.append(URLQueryItem(name: "archived", value: "1"))
        }
        let response: ListResponse = try await http.decoded("GET", ["conversations"], query: items)
        return response.conversations
    }

    public func conversation(id: String) async throws -> ConversationDetail {
        try await http.decoded("GET", ["conversations", id])
    }

    // Thumbs on a reply, through the same telemetry route as the web. Only the rating and the trace id leave the phone.
    public func sendFeedback(traceID: String, positive: Bool) async throws {
        guard ReplyFeedback.isTraceID(traceID) else {
            throw ApiError.invalidRequest
        }
        try await http.empty("POST", ["telemetry"], body: ["events": [["event": "reply_feedback", "trace_id": traceID, "positive": positive]]])
    }

    public func rename(id: String, title: String) async throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= Self.titleLimit else {
            throw ApiError.invalidRequest
        }
        try await http.empty("PATCH", ["conversations", id], body: ["title": trimmed])
    }

    public func setPinned(id: String, pinned: Bool) async throws {
        try await http.empty("PATCH", ["conversations", id], body: ["pinned": pinned])
    }

    public func setArchived(id: String, archived: Bool) async throws {
        try await http.empty("PATCH", ["conversations", id], body: ["archived": archived])
    }

    // Already gone is what the caller wanted.
    public func delete(id: String) async throws {
        do {
            try await http.empty("DELETE", ["conversations", id])
        } catch ApiError.notFound {}
    }

    // "Delete from here": a person's message and everything after it.
    public func deleteMessages(conversationID: String, from messageID: String) async throws {
        do {
            try await http.empty("DELETE", ["conversations", conversationID, "messages", messageID])
        } catch ApiError.notFound {}
    }

    // How much of an interrupted reply the person heard. `messageID` is the id the server stored the reply under.
    public func markHeard(conversationID: String, messageID: String, heardCharacters: Int) async throws {
        try await http.empty("PATCH", ["conversations", conversationID, "messages", messageID], body: ["heard_chars": heardCharacters, "interrupted": true])
    }
}

private struct ListResponse: Decodable {
    let conversations: [ConversationSummary]
}
