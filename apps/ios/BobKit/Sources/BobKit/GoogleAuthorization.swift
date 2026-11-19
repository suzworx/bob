import CryptoKit
import Foundation

/// An app-held proof. It is never stored, logged, or placed in a browser URL.
public struct GoogleAuthorizationProof: Sendable {
    public let verifier: String
    public var challenge: String { Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    public init(verifier: String) throws {
        guard Self.valid(verifier, length: 43...128) else { throw ApiError.invalidRequest }
        self.verifier = verifier
    }

    public static func random() -> Self {
        let key = SymmetricKey(size: .bits256)
        return Self(randomVerifier: key.withUnsafeBytes { base64URL(Data($0)) })
    }
    private init(randomVerifier: String) { verifier = randomVerifier }
    static func valid(_ value: String, length: ClosedRange<Int>) -> Bool {
        length.contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

public enum GoogleAuthorizationCallback: String, Sendable {
    case returned, cancelled, failed
    public static let scheme = "app.bob.oauth"

    public static func parse(_ url: URL, expectedState: String) throws -> Self {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == "google", parts.percentEncodedPath == "/callback",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let query = parts.queryItems, query.count == 2,
              query.filter({ $0.name == "state" }).count == 1,
              query.filter({ $0.name == "outcome" }).count == 1,
              let state = query.first(where: { $0.name == "state" })?.value,
              GoogleAuthorizationProof.valid(state, length: 43...43), state == expectedState,
              let outcome = query.first(where: { $0.name == "outcome" })?.value,
              let result = Self(rawValue: outcome) else { throw ApiError.invalidRequest }
        return result
    }
}

public struct GoogleAuthorizationAttempt: Decodable, Sendable {
    public let id: String
    public let state: String
    public let url: URL
    public let expiresAt: Date
    enum CodingKeys: String, CodingKey { case id = "attemptId", state, url, expiresAt }
    public init(id: String, state: String, url: URL, expiresAt: Date) {
        self.id = id; self.state = state; self.url = url; self.expiresAt = expiresAt
    }
    func validate() throws {
        guard UUID(uuidString: id) != nil, GoogleAuthorizationProof.valid(state, length: 43...43),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "https",
              parts.host?.isEmpty == false, parts.user == nil, parts.password == nil, parts.fragment == nil else {
            throw ApiError.invalidRequest
        }
    }
}

public enum GoogleAuthorizationResult: Equatable, Sendable, Decodable {
    case completed(GoogleIntegrationAccount)
    case processing(retryAfterMilliseconds: Int)
    case failed, cancelled, expired
    enum CodingKeys: String, CodingKey { case status, account, retryAfterMs }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .status) {
        case "completed": self = .completed(try values.decode(GoogleIntegrationAccount.self, forKey: .account))
        case "processing":
            let delay = try values.decode(Int.self, forKey: .retryAfterMs)
            guard (250...5000).contains(delay) else {
                throw DecodingError.dataCorruptedError(forKey: .retryAfterMs, in: values, debugDescription: "Invalid retry interval")
            }
            self = .processing(retryAfterMilliseconds: delay)
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        case "expired": self = .expired
        default: throw DecodingError.dataCorruptedError(forKey: .status, in: values, debugDescription: "Unknown authorization status")
        }
    }
}

public protocol GoogleAuthorizationService: Sendable {
    func authorize(capabilities: [GoogleCapability], reconnectAccountID: String?, challenge: String) async throws -> GoogleAuthorizationAttempt
    func complete(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult
    func cancel(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult
}

public struct GoogleAuthorizationClient: GoogleAuthorizationService {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession,
                accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func authorize(capabilities: [GoogleCapability], reconnectAccountID: String?, challenge: String) async throws -> GoogleAuthorizationAttempt {
        guard !capabilities.isEmpty, capabilities.count <= 6,
              Set(capabilities.map(\.rawValue)).count == capabilities.count,
              GoogleAuthorizationProof.valid(challenge, length: 43...43),
              reconnectAccountID == nil || UUID(uuidString: reconnectAccountID ?? "") != nil else { throw ApiError.invalidRequest }
        var body: [String: Any] = ["capabilities": capabilities.map(\.rawValue), "codeChallenge": challenge]
        if let reconnectAccountID { body["reconnectAccountId"] = reconnectAccountID }
        let attempt: GoogleAuthorizationAttempt = try await http.decoded("POST", ["google-accounts", "native", "authorize"], body: body)
        try attempt.validate()
        return attempt
    }
    public func complete(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult {
        try await submit("complete", attempt: attempt, proof: proof)
    }
    public func cancel(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult {
        try await submit("cancel", attempt: attempt, proof: proof)
    }
    private func submit(_ action: String, attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult {
        try await http.decoded("POST", ["google-accounts", "native", action], body: ["attemptId": attempt.id, "state": attempt.state, "codeVerifier": proof.verifier])
    }
}
