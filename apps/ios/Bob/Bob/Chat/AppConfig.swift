import BobKit
import Foundation

// Developer settings from the scheme's environment. Read in debug builds only; a release build never has them.
enum AppConfig {
    static let apiBaseURL: URL? = {
        #if DEBUG
        guard let value = ProcessInfo.processInfo.environment["BOB_API_BASE_URL"], !value.isEmpty else {
            return nil
        }
        return URL(string: value)
        #else
        return nil
        #endif
    }()

    static let devToken: String? = {
        #if DEBUG
        guard let value = ProcessInfo.processInfo.environment["BOB_DEV_TOKEN"], !value.isEmpty else {
            return nil
        }
        return value
        #else
        return nil
        #endif
    }()
}

// The one signed-in session every client shares. Refreshing rotates the token, so there must be exactly one.
enum AppSession {
    static let productionBaseURL = URL(string: "https://app.heybob.xyz")!

    // Where a person signs in. Nil for the demo data and for a developer token, which need no session.
    private static let liveBaseURL: URL? = {
        #if DEBUG
        return AppConfig.devToken == nil ? AppConfig.apiBaseURL : nil
        #else
        return productionBaseURL
        #endif
    }()

    @MainActor static let manager: SessionManager? = liveBaseURL.map { baseURL in
        let auth = SupabaseAuthClient(apiBaseURL: baseURL)
        return SessionManager(store: SessionStore(store: KeychainSecureStore())) { session in
            try await auth.refresh(refreshToken: session.refreshToken, previous: session)
        }
    }

    static let authClient: SupabaseAuthClient? = liveBaseURL.map { SupabaseAuthClient(apiBaseURL: $0) }

    @MainActor static let gate = SessionGate(manager: manager, beforeSignOut: {
        GoogleAuthenticationSession.cancelActive()
        await PushNotifications.shared.signedOut()
    })

    @MainActor static var nativeGoogleAvailable: Bool { liveBaseURL != nil && manager != nil }

    @MainActor static func googleAuthorizationContext() async throws -> GoogleAuthorizationContext {
        guard let baseURL = liveBaseURL, let session = manager,
              let identity = try await session.authorizationIdentity() else { throw ApiError.unauthenticated }
        let client = GoogleAuthorizationClient(baseURL: baseURL, accessToken: {
            let token = try await session.accessToken(matching: identity)
            if token == nil { await gate.check() }
            return token
        }, reauthenticate: Reauthenticator(fresh: { rejected in
            let token = try await session.accessToken(matching: identity, replacing: rejected)
            if token == nil { await gate.check() }
            return token
        }, rejected: { token in
            guard (try? await session.matches(identity)) == true else { return }
            try? await session.signOut(rejecting: token)
            await gate.check()
        }))
        return GoogleAuthorizationContext(service: client, isCurrent: { (try? await session.matches(identity)) == true })
    }

    @MainActor static func pushSession() async throws -> PushRegistrationSession? {
        guard let baseURL = liveBaseURL, let manager,
              let accountID = try await manager.userID(), let token = try await manager.accessToken(),
              try await manager.userID() == accountID else { return nil }
        let client = PushClient(baseURL: baseURL, token: token)
        return PushRegistrationSession(accountID: accountID,
                                       register: { try await client.register($0) },
                                       remove: { try await client.remove(installationID: $0) })
    }

    @MainActor static func make<Client>(_ build: (URL, @escaping @Sendable () async throws -> String?, Reauthenticator?) -> Client) -> Client? {
        #if DEBUG
        if let baseURL = AppConfig.apiBaseURL, let token = AppConfig.devToken {
            return build(baseURL, { token }, nil)
        }
        #endif
        guard let baseURL = liveBaseURL, let session = manager else {
            return nil
        }
        // No token means the session is gone: the gate looks again and goes back to sign-in.
        return build(baseURL, {
            let token = try await session.accessToken()
            if token == nil { await gate.check() }
            return token
        }, Reauthenticator(fresh: { rejected in
            let token = try await session.accessToken(replacing: rejected)
            if token == nil { await gate.check() }
            return token
        }, rejected: { token in
            // Even a just-refreshed token was refused, so a refresh cannot help. A failed Keychain delete still signs out for this run.
            try? await session.signOut(rejecting: token)
            await gate.check()
        }))
    }
}

// One chat stream and the store of past chats. In the demo they share their data, so a reply shows up when the chat is reopened.
struct ChatServices {
    let chat: ChatStreaming
    let conversations: ConversationsService
}

// Picks the chat services: the server when there is one, otherwise the scripted demo, which only a debug build can reach.
enum ChatServiceFactory {
    // One demo, so what Siri asks shows in the chat.
    private static let demo: ChatServices = {
        let conversations = StubConversationsService()
        return ChatServices(chat: StubChatService(conversations: conversations), conversations: conversations)
    }()

    @MainActor static func make() -> ChatServices {
        // Conversation text never reaches a URL cache.
        let client = AppSession.make { baseURL, accessToken, reauthenticate in
            ChatClient(baseURL: baseURL, session: MemoryClient.memoryOnlySession, accessToken: accessToken, reauthenticate: reauthenticate)
        }
        let conversations = AppSession.make { ConversationsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        guard let client, let conversations else {
            return demo
        }
        return ChatServices(chat: LiveChatService(client: client), conversations: conversations)
    }
}
