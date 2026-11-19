import Foundation

public struct SpaceSummary: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable {
        case `private`, pair, group
    }

    public let id: String
    public let kind: Kind
    public var name: String
    public var role: SpaceRole
    public let archivedAt: Date?
    public let updatedAt: Date?
    // Only the list carries these.
    public var unreadCount: Int
    public var threadCount: Int
    public let lastActivityAt: Date?

    public init(id: String, kind: Kind, name: String, role: SpaceRole = .owner, archivedAt: Date? = nil, updatedAt: Date? = nil, unreadCount: Int = 0, threadCount: Int = 0, lastActivityAt: Date? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.role = role
        self.archivedAt = archivedAt
        self.updatedAt = updatedAt
        self.unreadCount = unreadCount
        self.threadCount = threadCount
        self.lastActivityAt = lastActivityAt
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, name, role
        case archivedAt = "archived_at"
        case updatedAt = "updated_at"
        case unreadCount = "unread_count"
        case threadCount = "thread_count"
        case lastActivityAt = "last_activity_at"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(Kind.self, forKey: .kind)
        name = try values.decode(String.self, forKey: .name)
        role = try values.decodeIfPresent(SpaceRole.self, forKey: .role) ?? .member
        archivedAt = try values.decodeIfPresent(Date.self, forKey: .archivedAt)
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt)
        unreadCount = try values.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        threadCount = try values.decodeIfPresent(Int.self, forKey: .threadCount) ?? 0
        lastActivityAt = try values.decodeIfPresent(Date.self, forKey: .lastActivityAt)
    }
}

public enum SpaceRole: String, Decodable, Sendable {
    case owner, admin, member

    public var title: String {
        switch self {
        case .owner: "Owner"
        case .admin: "Admin"
        case .member: "Member"
        }
    }
}

// The two roles a person can be given; ownership moves separately.
public enum InviteRole: String, CaseIterable, Identifiable, Sendable {
    case member, admin

    public var id: String { rawValue }
    public var title: String { self == .admin ? "Admin" : "Member" }
}

public struct SpaceMember: Decodable, Equatable, Sendable, Identifiable {
    public let userID: String
    public let displayName: String?
    public let handle: String?
    public let email: String?
    public var role: SpaceRole
    public let joinedAt: Date?

    public var id: String { userID }

    public init(userID: String, displayName: String? = nil, handle: String? = nil, email: String? = nil, role: SpaceRole = .member, joinedAt: Date? = nil) {
        self.userID = userID
        self.displayName = displayName
        self.handle = handle
        self.email = email
        self.role = role
        self.joinedAt = joinedAt
    }

    enum CodingKeys: String, CodingKey {
        case handle, email, role
        case userID = "user_id"
        case displayName = "display_name"
        case joinedAt = "joined_at"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        userID = try values.decode(String.self, forKey: .userID)
        displayName = try values.decodeIfPresent(String.self, forKey: .displayName)
        handle = try values.decodeIfPresent(String.self, forKey: .handle)
        email = try values.decodeIfPresent(String.self, forKey: .email)
        role = try values.decodeIfPresent(SpaceRole.self, forKey: .role) ?? .member
        joinedAt = try values.decodeIfPresent(Date.self, forKey: .joinedAt)
    }
}

public struct SpaceInvitation: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String
    public let invitedEmail: String
    public let role: SpaceRole
    public let expiresAt: Date
    public let createdAt: Date

    public init(id: String, spaceID: String, invitedEmail: String, role: SpaceRole, expiresAt: Date, createdAt: Date) {
        self.id = id
        self.spaceID = spaceID
        self.invitedEmail = invitedEmail
        self.role = role
        self.expiresAt = expiresAt
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, role
        case spaceID = "space_id"
        case invitedEmail = "invited_email"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }
}

// A new invitation. The token is shown once: only its hash is kept, so it can't be read back.
public struct IssuedInvitation: Decodable, Equatable, Sendable {
    public let invitation: SpaceInvitation
    public let token: String
    public let emailSent: Bool

    public init(invitation: SpaceInvitation, token: String, emailSent: Bool) {
        self.invitation = invitation
        self.token = token
        self.emailSent = emailSent
    }

    enum CodingKeys: String, CodingKey {
        case invitation, token
        case emailSent = "email_sent"
    }
}

public struct InvitationPreview: Decodable, Equatable, Sendable {
    public let spaceName: String
    public let inviterName: String
    public let exposesHistory: Bool
    public let role: SpaceRole?
    public let expiresAt: Date?

    public init(spaceName: String, inviterName: String, exposesHistory: Bool = true, role: SpaceRole? = nil, expiresAt: Date? = nil) {
        self.spaceName = spaceName
        self.inviterName = inviterName
        self.exposesHistory = exposesHistory
        self.role = role
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case role
        case spaceName = "space_name"
        case inviterName = "inviter_display_name"
        case exposesHistory = "exposes_history"
        case expiresAt = "expires_at"
    }
}

// What accepting answered. Refusals come in the same shape as success, so they can each be worded.
public enum InvitationOutcome: String, Decodable, Sendable {
    case accepted
    case alreadyAccepted = "already_accepted"
    case alreadyMember = "already_member"
    case expired, revoked
    case emailMismatch = "email_mismatch"
    case notFound = "not_found"

    public var isJoined: Bool {
        self == .accepted || self == .alreadyAccepted || self == .alreadyMember
    }

    public var message: String {
        switch self {
        case .accepted: "You're in."
        case .alreadyAccepted, .alreadyMember: "You're already in this space."
        case .expired, .revoked, .notFound: "This invitation can't be used. It may have expired, been revoked, or already been used."
        case .emailMismatch: "This invitation was sent to a different account. Sign in with that account, or ask for a new invite."
        }
    }
}

// Spaces, who is in them and how people join.
public struct SpacesClient: Sendable {
    private let http: JSONRequester

    // Names and email addresses of other people, so nothing here reaches a URL cache.
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func spaces(archived: Bool = false) async throws -> [SpaceSummary] {
        let query = archived ? [URLQueryItem(name: "archived", value: "true")] : []
        let response: SpacesResponse = try await http.decoded("GET", ["spaces"], query: query)
        return response.spaces
    }

    // Every account has one; not finding it is reported like any missing thing.
    public func privateSpace() async throws -> SpaceSummary {
        guard let space = try await spaces().first(where: { $0.kind == .private }) else {
            throw ApiError.notFound
        }
        return space
    }

    public func space(id: String) async throws -> SpaceSummary {
        try await http.decoded("GET", ["spaces", id])
    }

    public func create(name: String) async throws -> SpaceSummary {
        try await http.decoded("POST", ["spaces"], body: ["name": name])
    }

    public func rename(spaceID: String, name: String) async throws -> SpaceSummary {
        try await http.decoded("PATCH", ["spaces", spaceID], body: ["name": name])
    }

    public func restore(spaceID: String) async throws -> SpaceSummary {
        try await http.decoded("PATCH", ["spaces", spaceID], body: ["archived": false])
    }

    public func archive(spaceID: String) async throws -> SpaceSummary {
        try await http.decoded("DELETE", ["spaces", spaceID])
    }

    public func members(spaceID: String) async throws -> [SpaceMember] {
        let response: MembersResponse = try await http.decoded("GET", ["spaces", spaceID, "members"])
        return response.members
    }

    // Also how a person leaves: they remove themselves.
    public func removeMember(spaceID: String, userID: String) async throws {
        try await http.empty("DELETE", ["spaces", spaceID, "members", userID])
    }

    public func setRole(spaceID: String, userID: String, role: InviteRole) async throws {
        try await http.empty("PATCH", ["spaces", spaceID, "members", userID], body: ["role": role.rawValue])
    }

    public func transferOwner(spaceID: String, userID: String) async throws -> SpaceSummary {
        try await http.decoded("PUT", ["spaces", spaceID, "owner"], body: ["user_id": userID])
    }

    // Only an owner or admin may list these; the server refuses anyone else.
    public func invitations(spaceID: String) async throws -> [SpaceInvitation] {
        let response: InvitationsResponse = try await http.decoded("GET", ["spaces", spaceID, "invitations"])
        return response.invitations
    }

    public func invite(spaceID: String, email: String, role: InviteRole) async throws -> IssuedInvitation {
        try await http.decoded("POST", ["spaces", spaceID, "invitations"], body: ["email": email, "role": role.rawValue])
    }

    public func revokeInvitation(id: String) async throws {
        try await http.empty("DELETE", ["invitations", id])
    }

    public func previewInvitation(token: String) async throws -> InvitationPreview {
        let response: PreviewResponse = try await http.decoded("GET", ["invitations", token])
        return response.preview
    }

    public func acceptInvitation(token: String) async throws -> InvitationOutcome {
        let response: AcceptResponse = try await http.decoded("POST", ["invitations", token, "accept"], accepting: [403, 404, 410])
        return response.status
    }
}

private struct SpacesResponse: Decodable {
    let spaces: [SpaceSummary]
}

private struct MembersResponse: Decodable {
    let members: [SpaceMember]
}

private struct InvitationsResponse: Decodable {
    let invitations: [SpaceInvitation]
}

private struct PreviewResponse: Decodable {
    let preview: InvitationPreview
}

private struct AcceptResponse: Decodable {
    let status: InvitationOutcome
}
