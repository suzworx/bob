import Foundation

public enum AdministrativeAccess: String, Sendable { case admin, metrics
    var path: String { self == .admin ? "admin" : "operator" }
}
public enum AdminAccountAction: String, CaseIterable, Sendable {
    case enable, disable, grantAdmin = "grant_admin", revokeAdmin = "revoke_admin"
    public var title: String {
        switch self { case .enable: "Enable sign-in"; case .disable: "Disable sign-in"; case .grantAdmin: "Make admin"; case .revokeAdmin: "Remove admin" }
    }
}
public struct AdminAccount: Decodable, Sendable, Identifiable {
    public enum Status: String, Decodable, Sendable { case enabled, disabled }
    public let id: String
    public let email: String?
    public let createdAt: String
    public let lastSignInAt: String?
    public let status: Status
    public let isAdmin: Bool
    public let emailConfirmed: Bool
    public func actions(selfID: String?) -> [AdminAccountAction] {
        var actions: [AdminAccountAction] = []
        if !isAdmin { actions.append(.grantAdmin) }
        else if let selfID, selfID != id { actions.append(.revokeAdmin) }
        if status == .disabled { actions.append(.enable) }
        else if let selfID, selfID != id { actions.append(.disable) }
        return actions
    }
}
public struct AdminAccountCounts: Decodable, Sendable {
    public let total, enabled, disabled, awaitingConfirmation: Int
}
public struct AdminAccountsPage: Decodable, Sendable {
    public let accounts: [AdminAccount]
    public let counts: AdminAccountCounts
    public let nextCursor: String?
}
public enum AdminWaitlistStatus: String, CaseIterable, Sendable {
    case all, waiting, pending, verified, withAccount = "with_account"
    public var title: String {
        switch self { case .all: "Everyone"; case .waiting: "Verified, waiting"; case .pending: "Awaiting verification"; case .verified: "Email verified"; case .withAccount: "Has an account" }
    }
}
public struct AdminWaitlistEntry: Decodable, Sendable, Identifiable {
    public enum AccountStatus: String, Decodable, Sendable { case none, enabled, disabled }
    public let id, email, source, createdAt: String
    public let verifiedAt: String?
    public let accountStatus: AccountStatus
}
public struct AdminWaitlistCounts: Decodable, Sendable {
    public let total, verified, pending, withAccount, waitingVerified: Int
}
public struct AdminWaitlistPage: Decodable, Sendable {
    public let entries: [AdminWaitlistEntry]
    public let counts: AdminWaitlistCounts
    public let nextCursor: String?
}
public struct AdminInvitationResult: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case created, exists }
    public enum Invitation: String, Decodable, Sendable { case queued, sent, failed }
    public let status: Status
    public let invitation: Invitation
}

public struct AdminClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func access(_ scope: AdministrativeAccess) async throws -> Bool {
        do {
            return try await http.auth.run { token in
                var request = URLRequest(url: http.baseURL.appendingPathComponent("api/\(scope.path)/access"))
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                let (body, response) = try await http.session.data(for: request)
                guard let response = response as? HTTPURLResponse else { throw ApiError.unknown(status: 0) }
                if response.statusCode == 204 { return true }
                if response.statusCode == 404 || response.statusCode == 403 { return false }
                if (200...299).contains(response.statusCode) { throw ApiError.unknown(status: response.statusCode) }
                throw ApiErrorMapper.map(status: response.statusCode, body: body, retryAfter: nil)
            }
        } catch let error as URLError { throw ApiErrorMapper.mapTransport(error.code) }
        catch ApiError.unauthenticated { return false }
    }
    public func accounts(query: String, cursor: String? = nil) async throws -> AdminAccountsPage {
        try await http.decoded("POST", ["admin", "accounts", "search"], body: search(query, cursor))
    }
    public func waitlist(query: String, status: AdminWaitlistStatus, cursor: String? = nil) async throws -> AdminWaitlistPage {
        var body = try search(query, cursor); body["status"] = status.rawValue
        return try await http.decoded("POST", ["admin", "waitlist", "search"], body: body)
    }
    public func manage(accountID: String, action: AdminAccountAction) async throws {
        guard UUID(uuidString: accountID) != nil else { throw ApiError.invalidRequest }
        let result: MutationResult = try await http.decoded("POST", ["admin", "accounts", "manage"], body: ["accountId": accountID, "action": action.rawValue])
        guard result.status == "updated" else { throw ApiError.unknown(status: 200) }
    }
    public func invite(email: String, retry: Bool) async throws -> AdminInvitationResult {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.validEmail(email) else { throw ApiError.invalidRequest }
        return try await http.decoded("POST", ["admin", "accounts"], body: ["email": email, "retryInvitation": retry])
    }
    public static func validEmail(_ value: String) -> Bool {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.utf16.count <= 254 && text.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }
    private func search(_ query: String, _ cursor: String?) throws -> [String: Any] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.utf16.count <= 254 else { throw ApiError.invalidRequest }
        if let cursor, cursor.count > 512 || cursor.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) == nil { throw ApiError.invalidRequest }
        var body: [String: Any] = ["query": query, "limit": 25]
        if let cursor { body["cursor"] = cursor }
        return body
    }
    private struct MutationResult: Decodable { let status: String }
}
