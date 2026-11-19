import Foundation

// Why a refresh did not produce a new session when the server answered clearly: the refresh token is dead.
public enum SessionRefreshError: Error, Equatable, Sendable {
    case revoked
}

// Why asking for or checking an emailed code failed, each one worded by SignInFlow.
public enum SignInError: Error, Equatable, Sendable {
    case badCode
    case unknownAddress
    case cooldown(seconds: Int)
    case emailCap
    case tooManyAttempts
    case unreachable
    case failed
    case notSaved
}

// Talks to Supabase Auth, using the address and public key the server hands out at GET /api/public-config.
public struct SupabaseAuthClient: Sendable {
    // What Supabase Auth answers when the refresh token can never work again. validation_failed is its answer to a malformed token.
    private static let deadTokenCodes: Set<String> = [
        "refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired", "validation_failed"
    ]

    // What Supabase Auth answers when asked for a code for an address with no account.
    private static let noAccountCodes: Set<String> = ["otp_disabled", "signup_disabled", "user_not_found"]

    private let apiBaseURL: URL
    private let session: URLSession
    private let now: @Sendable () -> Date

    public init(apiBaseURL: URL, session: URLSession = .shared, now: @escaping @Sendable () -> Date = { Date() }) {
        self.apiBaseURL = apiBaseURL
        self.session = session
        self.now = now
    }

    // Throws SessionRefreshError.revoked when the person must sign in again, and an ApiError when trying later can still work.
    public func refresh(refreshToken: String, previous: StoredSession) async throws -> StoredSession {
        let config = try await publicConfig()
        var components = URLComponents(url: config.supabaseUrl.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        guard let url = components?.url else {
            throw ApiError.unknown(status: 0)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(config.supabasePublishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["refresh_token": refreshToken])
        let (data, status) = try await loadRetryingOnce(request)
        // Only Supabase's own dead-token code signs a person out: a wrong public key or a proxy's 403 never does.
        if (status == 400 || status == 403),
           let failure = try? JSONDecoder().decode(AuthFailure.self, from: data),
           let code = failure.error_code, Self.deadTokenCodes.contains(code) {
            throw SessionRefreshError.revoked
        }
        guard (200...299).contains(status) else {
            throw status >= 500 ? ApiError.upstream : ApiError.unknown(status: status)
        }
        guard let token = try? JSONDecoder().decode(TokenResponse.self, from: data),
              let expiresAt = token.expiryDate(now: now()) else {
            throw ApiError.unknown(status: status)
        }
        return StoredSession(accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: expiresAt, userID: token.user?.id ?? previous.userID)
    }

    // Emails a six-digit code to an existing account. Invite-only: never creates one. Throws a SignInError.
    public func requestCode(email: String) async throws {
        let (data, status) = try await post("auth/v1/otp", OtpRequest(email: email, create_user: false))
        guard !(200...299).contains(status) else {
            return
        }
        let failure = try? JSONDecoder().decode(AuthFailure.self, from: data)
        if let limit = Self.rateLimit(status: status, failure: failure) {
            throw limit
        }
        if status == 422 || failure?.error_code.map(Self.noAccountCodes.contains) == true {
            throw SignInError.unknownAddress
        }
        throw status >= 500 ? SignInError.unreachable : SignInError.failed
    }

    // The email opens the existing recovery page for this deployment; it never replaces this session.
    public func requestPasswordReset(email: String) async throws {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, address.utf16.count <= 320 else { throw SignInError.failed }
        let redirect = apiBaseURL.appendingPathComponent("reset").absoluteString
        let (data, status) = try await post("auth/v1/recover", ["email": address], query: [URLQueryItem(name: "redirect_to", value: redirect)])
        guard !(200...299).contains(status) else { return }
        let failure = try? JSONDecoder().decode(AuthFailure.self, from: data)
        if let limit = Self.rateLimit(status: status, failure: failure) { throw limit }
        throw status >= 500 ? SignInError.unreachable : SignInError.failed
    }

    // Trades the emailed code for a session. Throws a SignInError.
    public func verifyCode(email: String, code: String) async throws -> StoredSession {
        let (data, status) = try await post("auth/v1/verify", VerifyRequest(type: "email", email: email, token: code))
        guard (200...299).contains(status) else {
            let failure = try? JSONDecoder().decode(AuthFailure.self, from: data)
            if let limit = Self.rateLimit(status: status, failure: failure) {
                throw limit
            }
            if status == 403 || failure?.error_code == "otp_expired" {
                throw SignInError.badCode
            }
            throw status >= 500 ? SignInError.unreachable : SignInError.failed
        }
        guard let token = try? JSONDecoder().decode(TokenResponse.self, from: data),
              let expiresAt = token.expiryDate(now: now()),
              let userID = token.user?.id else {
            throw SignInError.failed
        }
        return StoredSession(accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: expiresAt, userID: userID)
    }

    // Saves fields of the account's user metadata, such as its name. The token only carries them after its next refresh.
    public func updateMetadata(accessToken: String, _ fields: [String: String]) async throws {
        let status = try await authorized("PUT", "auth/v1/user", query: [], accessToken: accessToken, body: try? JSONEncoder().encode(["data": fields]))
        guard (200...299).contains(status) else {
            throw status >= 500 ? ApiError.upstream : ApiError.unknown(status: status)
        }
    }

    // Ends every session of the account. An answer that says the session is already gone counts as done.
    public func signOutEverywhere(accessToken: String) async throws {
        let status = try await authorized("POST", "auth/v1/logout", query: [URLQueryItem(name: "scope", value: "global")], accessToken: accessToken, body: nil)
        guard (200...299).contains(status) || status == 401 || status == 403 || status == 404 else {
            throw status >= 500 ? ApiError.upstream : ApiError.unknown(status: status)
        }
    }

    private func authorized(_ method: String, _ path: String, query: [URLQueryItem], accessToken: String, body: Data?) async throws -> Int {
        let config = try await publicConfig()
        var components = URLComponents(url: config.supabaseUrl.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else {
            throw ApiError.unknown(status: 0)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(config.supabasePublishableKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return try await load(request).1
    }

    // Supabase reuses over_email_send_rate_limit for two limits and tells them apart only by message:
    // the per-address cooldown names its seconds, the project-wide email cap does not. The message is parsed, never shown.
    private static func rateLimit(status: Int, failure: AuthFailure?) -> SignInError? {
        let code = failure?.error_code
        guard status == 429 || code == "over_email_send_rate_limit" || code == "over_request_rate_limit" else {
            return nil
        }
        if let text = failure?.msg ?? failure?.message,
           let match = try? /after (\d+) seconds?/.ignoresCase().firstMatch(in: text),
           let seconds = Int(match.1) {
            return .cooldown(seconds: seconds)
        }
        return code == "over_email_send_rate_limit" ? .emailCap : .tooManyAttempts
    }

    private func post<Body: Encodable>(_ path: String, _ body: Body, query: [URLQueryItem] = []) async throws -> (Data, Int) {
        do {
            let config = try await publicConfig()
            var components = URLComponents(url: config.supabaseUrl.appendingPathComponent(path), resolvingAgainstBaseURL: false)
            if !query.isEmpty { components?.queryItems = query }
            guard let url = components?.url else { throw SignInError.failed }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue(config.supabasePublishableKey, forHTTPHeaderField: "apikey")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(body)
            return try await load(request)
        } catch let error as ApiError {
            if case .unknown(let status) = error, status > 0, status < 500 {
                throw SignInError.failed
            }
            throw SignInError.unreachable
        }
    }

    private func publicConfig() async throws -> PublicConfig {
        var request = URLRequest(url: apiBaseURL.appendingPathComponent("api").appendingPathComponent("public-config"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, status) = try await load(request)
        guard (200...299).contains(status) else {
            throw status >= 500 ? ApiError.upstream : ApiError.unknown(status: status)
        }
        guard let config = try? JSONDecoder().decode(PublicConfig.self, from: data), !config.supabasePublishableKey.isEmpty else {
            throw ApiError.unknown(status: status)
        }
        return config
    }

    // The refresh may have worked with only its response lost. The same token is still accepted for a few seconds
    // after it is replaced, so asking again at once recovers; asking much later would look like reuse.
    private func loadRetryingOnce(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            return try await load(request)
        } catch let error as ApiError where error != .unknown(status: 0) {
            return try await load(request)
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.unknown(status: 0)
            }
            return (data, http.statusCode)
        } catch let error as URLError {
            throw ApiErrorMapper.mapTransport(error.code)
        }
    }
}

private struct PublicConfig: Decodable {
    let supabaseUrl: URL
    let supabasePublishableKey: String
}

private struct AuthFailure: Decodable {
    let error_code: String?
    let msg: String?
    let message: String?
}

private struct OtpRequest: Encodable {
    let email: String
    let create_user: Bool
}

private struct VerifyRequest: Encodable {
    let type: String
    let email: String
    let token: String
}

private struct TokenResponse: Decodable {
    struct User: Decodable {
        let id: String
    }

    let access_token: String
    let refresh_token: String
    let expires_at: TimeInterval?
    let expires_in: TimeInterval?
    let user: User?

    func expiryDate(now: Date) -> Date? {
        if let expires_at {
            return Date(timeIntervalSince1970: expires_at)
        }
        return expires_in.map { now.addingTimeInterval($0) }
    }
}
