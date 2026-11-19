import Foundation

// One conversation shared with other people. Its messages travel as a thread: its id is the thread's id.
public struct GroupChat: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String
    public var title: String
    public let createdBy: String
    public let role: SpaceRole
    public let createdAt: Date
    public let updatedAt: Date

    public init(id: String, spaceID: String, title: String, createdBy: String, role: SpaceRole, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.spaceID = spaceID
        self.title = title
        self.createdBy = createdBy
        self.role = role
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title, role
        case spaceID = "space_id"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct GroupChatMember: Decodable, Equatable, Sendable, Identifiable {
    public let userID: String
    public let displayName: String?
    public let role: SpaceRole

    public var id: String { userID }

    public init(userID: String, displayName: String?, role: SpaceRole) {
        self.userID = userID
        self.displayName = displayName
        self.role = role
    }

    enum CodingKeys: String, CodingKey {
        case role
        case userID = "user_id"
        case displayName = "display_name"
    }
}

public struct GroupChatPreview: Decodable, Equatable, Sendable {
    public let title: String
    public let inviterName: String
    public let expiresAt: Date

    public init(title: String, inviterName: String, expiresAt: Date) {
        self.title = title
        self.inviterName = inviterName
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case title
        case inviterName = "inviter_name"
        case expiresAt = "expires_at"
    }
}

public struct GroupChatLink: Decodable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Date

    public init(token: String, expiresAt: Date) {
        self.token = token
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
    }
}

public struct GroupChatsClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func chats() async throws -> [GroupChat] {
        let response: ChatsResponse = try await http.decoded("GET", ["group-chats"])
        return response.chats
    }

    public func chat(id: String) async throws -> GroupChat {
        let response: ChatResponse = try await http.decoded("GET", ["group-chats", id])
        return response.chat
    }

    // An empty chat, or a copy of a private one; the private one stays as it is. The same request id makes a retry safe.
    public func create(requestID: String, sourceConversationID: String? = nil, textOnly: Bool = false) async throws -> GroupChat {
        var body: [String: Any] = ["request_id": requestID]
        if let sourceConversationID { body["source_conversation_id"] = sourceConversationID }
        if textOnly { body["text_only"] = true }
        let response: ChatResponse = try await http.decoded("POST", ["group-chats"], body: body)
        return response.chat
    }

    public func preview(token: String) async throws -> GroupChatPreview {
        try await http.decoded("GET", ["group-chats", "invitations", token])
    }

    public func accept(token: String) async throws -> GroupChat {
        let response: ChatResponse = try await http.decoded("POST", ["group-chats", "invitations", token, "accept"])
        return response.chat
    }

    // The raw token is only in this answer.
    public func createLink(chatID: String) async throws -> GroupChatLink {
        try await http.decoded("POST", ["group-chats", chatID, "links"])
    }

    public func disableLinks(chatID: String) async throws {
        try await http.empty("DELETE", ["group-chats", chatID, "links"])
    }

    public func invite(chatID: String, email: String) async throws {
        let _: InviteSent = try await http.decoded("POST", ["group-chats", chatID, "invitations"], body: ["email": email])
    }

    public func members(chatID: String) async throws -> [GroupChatMember] {
        let response: GroupMembersResponse = try await http.decoded("GET", ["group-chats", chatID, "members"])
        return response.members
    }

    // Also how a person leaves.
    public func removeMember(chatID: String, userID: String) async throws {
        try await http.empty("DELETE", ["group-chats", chatID, "members", userID])
    }
}

private struct ChatsResponse: Decodable {
    let chats: [GroupChat]
}

private struct ChatResponse: Decodable {
    let chat: GroupChat
}

private struct GroupMembersResponse: Decodable {
    let members: [GroupChatMember]
}

private struct InviteSent: Decodable {
    let sent: Bool
}
