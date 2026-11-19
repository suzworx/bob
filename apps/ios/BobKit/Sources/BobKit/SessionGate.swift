import Observation

// Decides whether the shell or the sign-in screen shows. With no manager (demo data, developer token) it is always the shell.
@MainActor @Observable public final class SessionGate {
    public enum State: Equatable, Sendable {
        case checking
        case signedIn
        case signedOut
    }

    public private(set) var state = State.checking
    @ObservationIgnored private let manager: SessionManager?
    @ObservationIgnored private let beforeSignOut: @MainActor () async -> Void
    private var generation = 0

    public init(manager: SessionManager?, beforeSignOut: @escaping @MainActor () async -> Void = {}) {
        self.manager = manager
        self.beforeSignOut = beforeSignOut
    }

    public func check() async {
        guard let manager else {
            state = .signedIn
            return
        }
        // A locked Keychain can open later and the session is kept, so it does not count as signed out.
        let attempt = generation
        let signedIn = (try? await manager.isSignedIn()) ?? true
        guard generation == attempt else { return }
        if !signedIn { await beforeSignOut() }
        guard generation == attempt else { return }
        state = signedIn ? .signedIn : .signedOut
    }

    public func signOut() async {
        generation += 1
        let attempt = generation
        await beforeSignOut()
        guard generation == attempt else { return }
        try? await manager?.signOut()
        guard generation == attempt else { return }
        if manager != nil { state = .signedOut }
    }

    public func signIn(_ session: StoredSession) async throws {
        generation += 1
        let attempt = generation
        try await manager?.signIn(session)
        guard generation == attempt else { return }
        state = .signedIn
    }
}
