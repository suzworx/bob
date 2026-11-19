import Foundation

public struct SpaceThread: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String
    public var title: String
    public let createdBy: String
    public let archivedAt: Date?
    public let lastSequence: Int
    public var unreadCount: Int
    public let createdAt: Date
    public let updatedAt: Date

    public init(id: String, spaceID: String, title: String, createdBy: String, archivedAt: Date? = nil, lastSequence: Int = 0, unreadCount: Int = 0, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.spaceID = spaceID
        self.title = title
        self.createdBy = createdBy
        self.archivedAt = archivedAt
        self.lastSequence = lastSequence
        self.unreadCount = unreadCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title
        case spaceID = "space_id"
        case createdBy = "created_by"
        case archivedAt = "archived_at"
        case lastSequence = "last_sequence"
        case unreadCount = "unread_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct ThreadMessage: Decodable, Equatable, Sendable, Identifiable {
    public enum Origin: String, Decodable, Sendable {
        case webText = "web_text"
        case webVoice = "web_voice"
        case device
    }

    public let id: String
    public let threadID: String
    public let spaceID: String
    // Nil for Bob.
    public let authorUserID: String?
    public let body: String
    public let replyToMessageID: String?
    public let sequence: Int
    public let clientMessageID: String
    public let revision: Int
    public let tombstonedAt: Date?
    public let createdAt: Date
    public let updatedAt: Date
    public let origin: Origin

    public init(id: String, threadID: String, spaceID: String, authorUserID: String?, body: String, replyToMessageID: String? = nil, sequence: Int, clientMessageID: String, revision: Int = 1, tombstonedAt: Date? = nil, createdAt: Date, updatedAt: Date, origin: Origin = .webText) {
        self.id = id
        self.threadID = threadID
        self.spaceID = spaceID
        self.authorUserID = authorUserID
        self.body = body
        self.replyToMessageID = replyToMessageID
        self.sequence = sequence
        self.clientMessageID = clientMessageID
        self.revision = revision
        self.tombstonedAt = tombstonedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.origin = origin
    }

    enum CodingKeys: String, CodingKey {
        case id, body, sequence, revision, origin
        case threadID = "thread_id"
        case spaceID = "space_id"
        case authorUserID = "author_user_id"
        case replyToMessageID = "reply_to_message_id"
        case clientMessageID = "client_message_id"
        case tombstonedAt = "tombstoned_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct ThreadMessages: Equatable, Sendable {
    public let messages: [ThreadMessage]
    // More exist than were loaded, so reading must not be marked past the last one here.
    public let isCapped: Bool

    public init(messages: [ThreadMessage], isCapped: Bool = false) {
        self.messages = messages
        self.isCapped = isCapped
    }
}

public struct ThreadInvocation: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable {
        case queued, running, completed, failed, cancelled

        public var isFinished: Bool { self != .queued && self != .running }
    }

    public let id: String
    public let state: State
    public let resultMessageID: String?

    public init(id: String, state: State, resultMessageID: String? = nil) {
        self.id = id
        self.state = state
        self.resultMessageID = resultMessageID
    }

    enum CodingKeys: String, CodingKey {
        case id, state
        case resultMessageID = "result_message_id"
    }
}

// What came of asking Bob in a thread.
public enum AskBobOutcome: Equatable, Sendable {
    case answered, failed, cancelled
    // He's already answering in this thread.
    case busy
    // Still working after the wait ran out.
    case pending
}

// Threads in a space and the group chats built on them: posting is a person's message and never wakes Bob by itself.
public struct ThreadsClient: Sendable {
    public static let pageSize = 200
    // A runaway guard: 5000 messages at most.
    public static let maxPages = 25
    public static let pollAttempts = 20
    public static let pollDelay: Duration = .milliseconds(1500)

    private let http: JSONRequester
    private let pollDelay: Duration

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, pollDelay: Duration = ThreadsClient.pollDelay, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
        self.pollDelay = pollDelay
    }

    public func threads(spaceID: String) async throws -> [SpaceThread] {
        let response: ThreadsResponse = try await http.decoded("GET", ["spaces", spaceID, "threads"])
        return response.threads
    }

    public func create(spaceID: String, title: String) async throws -> SpaceThread {
        try await http.decoded("POST", ["spaces", spaceID, "threads"], body: ["title": title])
    }

    public func thread(id: String) async throws -> SpaceThread {
        try await http.decoded("GET", ["threads", id])
    }

    public func rename(threadID: String, title: String) async throws -> SpaceThread {
        try await http.decoded("PATCH", ["threads", threadID], body: ["title": title])
    }

    public func archive(threadID: String) async throws -> SpaceThread {
        try await http.decoded("DELETE", ["threads", threadID])
    }

    public func messages(threadID: String) async throws -> ThreadMessages {
        var messages: [ThreadMessage] = []
        var cursor: String?
        for _ in 0..<Self.maxPages {
            var query = [URLQueryItem(name: "limit", value: String(Self.pageSize))]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let page: MessagesPage = try await http.decoded("GET", ["threads", threadID, "messages"], query: query)
            messages += page.messages
            guard let next = page.nextCursor else {
                return ThreadMessages(messages: messages)
            }
            cursor = next
        }
        return ThreadMessages(messages: messages, isCapped: true)
    }

    // A retry with the same client id answers with the first message, so it can't post twice.
    public func post(threadID: String, body: String, clientMessageID: String) async throws -> ThreadMessage {
        try await http.decoded("POST", ["threads", threadID, "messages"], body: ["body": body, "client_message_id": clientMessageID])
    }

    public func edit(messageID: String, body: String) async throws -> ThreadMessage {
        try await http.decoded("PATCH", ["messages", messageID], body: ["body": body])
    }

    // Leaves a "deleted" mark in the thread for everyone.
    public func delete(messageID: String) async throws -> ThreadMessage {
        try await http.decoded("DELETE", ["messages", messageID])
    }

    // Without a sequence, everything in the thread counts as read.
    public func markRead(threadID: String, through sequence: Int? = nil) async throws {
        try await http.empty("PUT", ["threads", threadID, "read"], body: sequence.map { ["last_read_sequence": $0] })
    }

    public func invoke(threadID: String, triggerMessageID: String, appBinding: ChatAppBinding? = nil) async throws -> String {
        guard appBinding?.isValid != false else { throw ApiError.invalidRequest }
        var body: [String: Any] = ["trigger_message_id": triggerMessageID]
        if let appBinding { body["appBinding"] = appBinding.object }
        let response: InvocationCreated = try await http.decoded("POST", ["threads", threadID, "invocations"], body: body)
        return response.invocationID
    }

    public func invocation(id: String) async throws -> ThreadInvocation {
        try await http.decoded("GET", ["invocations", id])
    }

    // Asks Bob to answer this message, then waits. The server normally finishes before the first look.
    public func askBob(threadID: String, triggerMessageID: String) async throws -> AskBobOutcome {
        try await askBob(threadID: threadID, triggerMessageID: triggerMessageID, appBinding: nil)
    }

    public func askBob(threadID: String, triggerMessageID: String, appBinding: ChatAppBinding?) async throws -> AskBobOutcome {
        let id: String
        do {
            id = try await invoke(threadID: threadID, triggerMessageID: triggerMessageID, appBinding: appBinding)
        } catch ApiError.unknown(status: 409) {
            if appBinding != nil { throw ApiError.unknown(status: 409) }
            return .busy
        }
        for attempt in 0..<Self.pollAttempts {
            if attempt > 0 { try await Task.sleep(for: pollDelay) }
            let invocation = try await invocation(id: id)
            switch invocation.state {
            case .completed: return .answered
            case .cancelled: return .cancelled
            case .failed: return .failed
            case .queued, .running: continue
            }
        }
        return .pending
    }
}

private struct ThreadsResponse: Decodable {
    let threads: [SpaceThread]
}

private struct MessagesPage: Decodable {
    let messages: [ThreadMessage]
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case messages
        case nextCursor = "next_cursor"
    }
}

private struct InvocationCreated: Decodable {
    let invocationID: String

    enum CodingKeys: String, CodingKey {
        case invocationID = "invocation_id"
    }
}
