import Foundation

// What a client does after a 401: asks for a fresh token, and reports when the server rejects that one too.
public struct Reauthenticator: Sendable {
    let fresh: @Sendable (String) async throws -> String?
    let rejected: @Sendable (String) async -> Void

    public init(fresh: @escaping @Sendable (String) async throws -> String?, rejected: @escaping @Sendable (String) async -> Void = { _ in }) {
        self.fresh = fresh
        self.rejected = rejected
    }
}

// Runs one authorized request: signs it with the current token and, after a 401, repeats it once with a fresh token.
struct RequestAuth: Sendable {
    let accessToken: @Sendable () async throws -> String?
    let reauthenticate: Reauthenticator?

    func run<T>(_ attempt: (String) async throws -> T) async throws -> T {
        guard let token = try await accessToken(), !token.isEmpty else {
            throw ApiError.unauthenticated
        }
        do {
            return try await attempt(token)
        } catch ApiError.unauthenticated {
            guard let reauthenticate, let fresh = try await reauthenticate.fresh(token), !fresh.isEmpty else {
                throw ApiError.unauthenticated
            }
            do {
                return try await attempt(fresh)
            } catch ApiError.unauthenticated {
                await reauthenticate.rejected(fresh)
                throw ApiError.unauthenticated
            }
        }
    }
}
