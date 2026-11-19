import Foundation

/// A local session lifetime, unchanged by refresh and replaced on every sign-in/out.
public struct SessionAuthorizationIdentity: Equatable, Sendable {
    public let accountID: String
    fileprivate let managerID: UUID
    fileprivate let generation: Int
}

// Owns the signed-in session: hands out a valid access token and refreshes it, one refresh at a time because each one replaces the refresh token.
public actor SessionManager {
    public typealias Refresher = @Sendable (StoredSession) async throws -> StoredSession

    private let store: SessionStore
    private let refresher: Refresher
    private let now: @Sendable () -> Date
    private var current: StoredSession?
    private var loaded = false
    private var refreshTask: Task<StoredSession?, Error>?
    // Moves on every sign-in and sign-out so a refresh already in flight cannot bring an old session back.
    private var generation = 0
    private let managerID = UUID()

    public init(store: SessionStore, now: @escaping @Sendable () -> Date = { Date() }, refresher: @escaping Refresher) {
        self.store = store
        self.now = now
        self.refresher = refresher
    }

    public func isSignedIn() throws -> Bool {
        try loadIfNeeded() != nil
    }

    // Local notification ownership needs the account, never its credentials.
    public func userID() throws -> String? {
        try loadIfNeeded()?.userID
    }

    public func authorizationIdentity() throws -> SessionAuthorizationIdentity? {
        guard let session = try loadIfNeeded() else { return nil }
        return SessionAuthorizationIdentity(accountID: session.userID, managerID: managerID, generation: generation)
    }

    public func matches(_ identity: SessionAuthorizationIdentity) throws -> Bool {
        try authorizationIdentity() == identity
    }

    /// Scoped requests must never borrow the next account's token after an await.
    public func accessToken(matching identity: SessionAuthorizationIdentity, replacing rejected: String? = nil) async throws -> String? {
        guard try matches(identity) else { return nil }
        let token: String?
        if let rejected { token = try await accessToken(replacing: rejected) }
        else { token = try await accessToken() }
        guard try matches(identity) else { return nil }
        return token
    }

    // Nil when signed out. Throws an ApiError when the token has expired and cannot be refreshed right now; the session is kept.
    public func accessToken() async throws -> String? {
        guard let session = try loadIfNeeded() else {
            return nil
        }
        guard SessionStore.isExpired(session, now: now()) else {
            return session.accessToken
        }
        return try await refreshed(from: session)?.accessToken
    }

    // After the server rejects `rejected`: a fresh token, or nil when the person must sign in again.
    public func accessToken(replacing rejected: String) async throws -> String? {
        guard let session = try loadIfNeeded() else {
            return nil
        }
        if session.accessToken != rejected {
            return session.accessToken
        }
        return try await refreshed(from: session)?.accessToken
    }

    // Saved first, so a failure leaves nothing that would vanish at the next launch.
    public func signIn(_ session: StoredSession) throws {
        do {
            try store.save(session)
        } catch {
            throw ApiError.unknown(status: 0)
        }
        generation += 1
        refreshTask = nil
        current = session
        loaded = true
    }

    // Signed out for this run either way; a throw means the Keychain still holds the session for the next launch.
    public func signOut() throws {
        generation += 1
        refreshTask = nil
        current = nil
        loaded = true
        do {
            try store.clear()
        } catch {
            throw ApiError.unknown(status: 0)
        }
    }

    // The server rejected a token that was just refreshed. Does nothing if a newer session has replaced it since.
    public func signOut(rejecting token: String) throws {
        guard try loadIfNeeded()?.accessToken == token else {
            return
        }
        try signOut()
    }

    private func loadIfNeeded() throws -> StoredSession? {
        if loaded {
            return current
        }
        do {
            current = try store.load()
        } catch {
            // The Keychain can be locked before the first unlock; reading again later can still work.
            throw ApiError.unknown(status: 0)
        }
        loaded = true
        return current
    }

    private func refreshed(from session: StoredSession) async throws -> StoredSession? {
        if let refreshTask {
            return try await refreshTask.value
        }
        // Read now: the task's body runs later, possibly after a sign-out already queued on this actor.
        let generation = self.generation
        let task = Task { try await self.performRefresh(of: session, generation: generation) }
        refreshTask = task
        return try await task.value
    }

    // An unstructured task, so a person leaving the screen cannot cancel a refresh and lose the replaced token.
    private func performRefresh(of session: StoredSession, generation: Int) async throws -> StoredSession? {
        do {
            let fresh = try await refresher(session)
            guard generation == self.generation else {
                return current
            }
            refreshTask = nil
            current = fresh
            // If this write fails the session still works until the app restarts, when the person signs in again.
            try? store.save(fresh)
            return fresh
        } catch SessionRefreshError.revoked {
            guard generation == self.generation else {
                return current
            }
            try? signOut()
            return nil
        } catch let error as ApiError {
            if generation == self.generation {
                refreshTask = nil
            }
            throw error
        } catch {
            if generation == self.generation {
                refreshTask = nil
            }
            throw ApiError.unknown(status: 0)
        }
    }
}
