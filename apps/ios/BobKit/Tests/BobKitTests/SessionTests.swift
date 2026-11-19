import XCTest
@testable import BobKit

private func session(_ access: String = "a1", refresh: String = "r1", expiresIn: TimeInterval = 3600) -> StoredSession {
    StoredSession(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(expiresIn), userID: "u1")
}

private actor Counter {
    private(set) var value = 0
    func next() -> Int {
        value += 1
        return value
    }
}

// Holds a refresh open until the test releases it, so ordering never depends on the clock.
private actor Gate {
    private var entered: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    private var hasEntered = false

    func enter() async {
        hasEntered = true
        entered?.resume()
        entered = nil
        await withCheckedContinuation { release = $0 }
    }

    func waitUntilEntered() async {
        if hasEntered {
            return
        }
        await withCheckedContinuation { entered = $0 }
    }

    func open() {
        release?.resume()
        release = nil
    }
}

private func manager(saved: StoredSession?, refresher: @escaping SessionManager.Refresher) throws -> (SessionManager, SessionStore) {
    let store = SessionStore(store: InMemorySecureStore())
    if let saved {
        try store.save(saved)
    }
    return (SessionManager(store: store, refresher: refresher), store)
}

final class SessionManagerTests: XCTestCase {
    func testScopedAuthorizationIdentitySurvivesRefreshButRejectsSameAccountResignIn() async throws {
        let (subject, _) = try manager(saved: session(expiresIn: -10)) { _ in session("refreshed") }
        let snapshot = try await subject.authorizationIdentity()
        let identity = try XCTUnwrap(snapshot)
        let refreshed = try await subject.accessToken(matching: identity)
        XCTAssertEqual(refreshed, "refreshed")
        try await subject.signIn(session("replacement"))
        let stale = try await subject.accessToken(matching: identity)
        XCTAssertNil(stale)
    }

    func testScopedAuthorizationCannotBorrowReplacementAccountTokenDuringRefresh() async throws {
        let gate = Gate()
        let (subject, _) = try manager(saved: session(expiresIn: -10)) { _ in
            await gate.enter()
            return session("old-refreshed")
        }
        let snapshot = try await subject.authorizationIdentity()
        let identity = try XCTUnwrap(snapshot)
        let pending = Task { try await subject.accessToken(matching: identity) }
        await gate.waitUntilEntered()
        try await subject.signIn(StoredSession(accessToken: "other-token", refreshToken: "other-refresh", expiresAt: Date().addingTimeInterval(3600), userID: "u2"))
        await gate.open()
        let token = try await pending.value
        XCTAssertNil(token)
    }

    func testNotificationIdentityFollowsSignOutAndAccountSwitchWithoutRefreshingTokens() async throws {
        let (subject, _) = try manager(saved: session(expiresIn: -10)) { _ in
            XCTFail("Reading local notification ownership must not refresh tokens")
            throw ApiError.upstream
        }
        let original = try await subject.userID()
        XCTAssertEqual(original, "u1")
        try await subject.signOut()
        let signedOut = try await subject.userID()
        XCTAssertNil(signedOut)
        try await subject.signIn(StoredSession(accessToken: "other", refreshToken: "other-refresh", expiresAt: Date(), userID: "u2"))
        let replacement = try await subject.userID()
        XCTAssertEqual(replacement, "u2")
    }

    func testSignedOutHasNoToken() async throws {
        let (subject, _) = try manager(saved: nil) { _ in XCTFail("no refresh"); throw ApiError.upstream }
        let token = try await subject.accessToken()
        XCTAssertNil(token)
    }

    func testValidTokenIsReturnedWithoutRefreshing() async throws {
        let (subject, _) = try manager(saved: session()) { _ in XCTFail("no refresh"); throw ApiError.upstream }
        let token = try await subject.accessToken()
        XCTAssertEqual(token, "a1")
    }

    func testExpiredTokenRefreshesAndPersistsTheRotatedSession() async throws {
        let (subject, store) = try manager(saved: session(expiresIn: -10)) { old in
            XCTAssertEqual(old.refreshToken, "r1")
            return session("a2", refresh: "r2")
        }
        let token = try await subject.accessToken()
        XCTAssertEqual(token, "a2")
        XCTAssertEqual(try store.load()?.refreshToken, "r2")
    }

    func testConcurrentCallersShareOneRefresh() async throws {
        let counter = Counter()
        let (subject, _) = try manager(saved: session(expiresIn: -10)) { _ in
            let n = await counter.next()
            await Task.yield()
            return session("a\(n + 1)", refresh: "r\(n + 1)")
        }
        let tokens = try await withThrowingTaskGroup(of: String?.self) { group in
            for _ in 0..<8 {
                group.addTask { try await subject.accessToken() }
            }
            return try await group.reduce(into: [String?]()) { $0.append($1) }
        }
        XCTAssertEqual(Set(tokens), ["a2"])
        let refreshes = await counter.value
        XCTAssertEqual(refreshes, 1)
    }

    func testRejectionOfAnOldTokenReturnsTheNewerOneWithoutRefreshing() async throws {
        let (subject, _) = try manager(saved: session("a2")) { _ in XCTFail("no refresh"); throw ApiError.upstream }
        let token = try await subject.accessToken(replacing: "a1")
        XCTAssertEqual(token, "a2")
    }

    func testRevokedRefreshSignsOutAndClearsTheStore() async throws {
        let (subject, store) = try manager(saved: session()) { _ in throw SessionRefreshError.revoked }
        let token = try await subject.accessToken(replacing: "a1")
        XCTAssertNil(token)
        XCTAssertNil(try store.load())
        let signedIn = try await subject.isSignedIn()
        XCTAssertFalse(signedIn)
    }

    func testTransientFailureKeepsTheSessionAndTheNextCallRetries() async throws {
        let counter = Counter()
        let (subject, store) = try manager(saved: session(expiresIn: -10)) { _ in
            if await counter.next() == 1 {
                throw ApiError.upstream
            }
            return session("a2", refresh: "r2")
        }
        do {
            _ = try await subject.accessToken()
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .upstream)
        }
        XCTAssertEqual(try store.load()?.refreshToken, "r1")
        let token = try await subject.accessToken()
        XCTAssertEqual(token, "a2")
    }

    func testSignOutDuringARefreshDoesNotBringTheSessionBack() async throws {
        let gate = Gate()
        let (subject, store) = try manager(saved: session(expiresIn: -10)) { _ in
            await gate.enter()
            return session("a2", refresh: "r2")
        }
        let pending = Task { try await subject.accessToken() }
        await gate.waitUntilEntered()
        try await subject.signOut()
        await gate.open()
        let token = try await pending.value
        XCTAssertNil(token)
        XCTAssertNil(try store.load())
    }

    // The sign-out is queued on the actor before the refresh task's body can start.
    func testSignOutQueuedBeforeTheRefreshStartsIsNotUndone() async throws {
        for _ in 0..<200 {
            let (subject, store) = try manager(saved: session(expiresIn: -10)) { _ in session("a2", refresh: "r2") }
            let pending = Task { try await subject.accessToken() }
            let out = Task { try await subject.signOut() }
            _ = try await pending.value
            try await out.value
            let signedIn = try await subject.isSignedIn()
            XCTAssertFalse(signedIn)
            XCTAssertNil(try store.load())
        }
    }

    func testCancellingACallerDoesNotLoseTheRotatedToken() async throws {
        let gate = Gate()
        let (subject, store) = try manager(saved: session(expiresIn: -10)) { _ in
            await gate.enter()
            return session("a2", refresh: "r2")
        }
        let pending = Task { try await subject.accessToken() }
        await gate.waitUntilEntered()
        pending.cancel()
        await gate.open()
        _ = try? await pending.value
        let token = try await subject.accessToken()
        XCTAssertEqual(token, "a2")
        XCTAssertEqual(try store.load()?.refreshToken, "r2")
    }

    func testFailedSaveDuringSignInLeavesThePersonSignedOut() async throws {
        let backing = InMemorySecureStore()
        let subject = SessionManager(store: SessionStore(store: backing)) { _ in throw ApiError.upstream }
        backing.isAvailable = false
        do {
            try await subject.signIn(session())
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unknown(status: 0))
        }
        backing.isAvailable = true
        let signedIn = try await subject.isSignedIn()
        XCTAssertFalse(signedIn)
    }

    func testFailedDeleteDuringSignOutIsReported() async throws {
        let backing = InMemorySecureStore()
        let store = SessionStore(store: backing)
        try store.save(session())
        let subject = SessionManager(store: store) { _ in throw ApiError.upstream }
        backing.isAvailable = false
        do {
            try await subject.signOut()
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unknown(status: 0))
        }
    }
}

final class RequestAuthTests: XCTestCase {
    func testA401RepeatsOnceWithTheFreshToken() async throws {
        let auth = RequestAuth(accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { rejected in
            XCTAssertEqual(rejected, "old")
            return "new"
        }))
        var seen: [String] = []
        let result: Int = try await auth.run { token in
            seen.append(token)
            if token == "old" {
                throw ApiError.unauthenticated
            }
            return 7
        }
        XCTAssertEqual(result, 7)
        XCTAssertEqual(seen, ["old", "new"])
    }

    func testASecond401IsNotRepeatedAgain() async {
        let auth = RequestAuth(accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { _ in "new" }))
        var attempts = 0
        do {
            let _: Int = try await auth.run { _ in
                attempts += 1
                throw ApiError.unauthenticated
            }
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unauthenticated)
        }
        XCTAssertEqual(attempts, 2)
    }

    func testNoFreshTokenEndsAsUnauthenticated() async {
        let auth = RequestAuth(accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { _ in nil }))
        do {
            let _: Int = try await auth.run { _ in throw ApiError.unauthenticated }
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unauthenticated)
        }
    }

    func testNoTokenMakesNoAttempt() async {
        let auth = RequestAuth(accessToken: { nil }, reauthenticate: nil)
        do {
            let _: Int = try await auth.run { _ in XCTFail("no attempt"); return 1 }
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unauthenticated)
        }
    }
}

final class KeychainSecureStoreTests: XCTestCase {
    func testWriteReadReplaceDelete() throws {
        let store = KeychainSecureStore(service: "app.bob.ios.tests.\(UUID().uuidString)")
        addTeardownBlock { try? store.delete(key: "k") }
        XCTAssertNil(try store.read(key: "k"))
        try store.write(Data("one".utf8), key: "k")
        try store.write(Data("two".utf8), key: "k")
        XCTAssertEqual(try store.read(key: "k"), Data("two".utf8))
        try store.delete(key: "k")
        XCTAssertNil(try store.read(key: "k"))
        try store.delete(key: "k")
    }
}

private final class AuthStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    // Failures for a path, used up one request at a time.
    nonisolated(unsafe) static var failures: [String: [URLError.Code]] = [:]
    nonisolated(unsafe) static var apiKey: String?
    nonisolated(unsafe) static var requests: [String] = []

    static func reset() {
        routes = [:]
        failures = [:]
        apiKey = nil
        requests = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let bearer = request.value(forHTTPHeaderField: "Authorization") ?? ""
        Self.requests.append(url.path + " " + bearer)
        if var pending = Self.failures[url.path], !pending.isEmpty {
            let code = pending.removeFirst()
            Self.failures[url.path] = pending
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        if url.path.hasSuffix("token") {
            Self.apiKey = request.value(forHTTPHeaderField: "apikey")
        }
        var (status, body) = Self.routes[url.path] ?? (404, "{}")
        if bearer == "Bearer old" {
            (status, body) = (401, "{}")
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AuthStub.self]
    return URLSession(configuration: configuration)
}

final class SupabaseAuthClientTests: XCTestCase {
    private let tokenPath = "/auth/v1/token"
    private let previous = StoredSession(accessToken: "a1", refreshToken: "r1", expiresAt: .distantPast, userID: "u1")
    private let good = #"{"access_token":"a2","refresh_token":"r2","expires_in":3600,"user":{"id":"u2"}}"#

    private func client() -> SupabaseAuthClient {
        SupabaseAuthClient(apiBaseURL: URL(string: "https://api.example.test")!, session: stubSession(), now: { Date(timeIntervalSince1970: 1000) })
    }

    override func setUp() {
        AuthStub.reset()
        AuthStub.routes["/api/public-config"] = (200, #"{"supabaseUrl":"https://db.example.test","supabasePublishableKey":"sb_publishable_x","pairingUrl":""}"#)
    }

    func testRefreshParsesTheRotatedSessionAndSendsThePublicKey() async throws {
        AuthStub.routes[tokenPath] = (200, good)
        let fresh = try await client().refresh(refreshToken: "r1", previous: previous)
        XCTAssertEqual(fresh, StoredSession(accessToken: "a2", refreshToken: "r2", expiresAt: Date(timeIntervalSince1970: 4600), userID: "u2"))
        XCTAssertEqual(AuthStub.apiKey, "sb_publishable_x")
    }

    func testExpiresAtWinsOverExpiresIn() async throws {
        AuthStub.routes[tokenPath] = (200, #"{"access_token":"a2","refresh_token":"r2","expires_at":9000,"expires_in":3600}"#)
        let fresh = try await client().refresh(refreshToken: "r1", previous: previous)
        XCTAssertEqual(fresh.expiresAt, Date(timeIntervalSince1970: 9000))
        XCTAssertEqual(fresh.userID, "u1")
    }

    func testDeadTokenCodesAreRevoked() async {
        // validation_failed is what the hosted project answers for a malformed token, probed on 2026-10-30.
        for code in ["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired", "validation_failed"] {
            AuthStub.routes[tokenPath] = (400, #"{"code":400,"error_code":"\#(code)"}"#)
            do {
                _ = try await client().refresh(refreshToken: "r1", previous: previous)
                XCTFail("expected a throw")
            } catch {
                XCTAssertEqual(error as? SessionRefreshError, .revoked, code)
            }
        }
    }

    func testOtherFailuresNeverRevoke() async {
        let replies: [(Int, String)] = [
            (400, #"{"error_code":"bad_json"}"#), (400, "not json"), (403, "<html>blocked by proxy</html>"),
            (401, #"{"message":"Invalid API key"}"#), (429, "{}"), (500, "{}"), (503, "{}"), (200, "not json")
        ]
        for reply in replies {
            AuthStub.routes[tokenPath] = reply
            do {
                _ = try await client().refresh(refreshToken: "r1", previous: previous)
                XCTFail("expected a throw")
            } catch {
                XCTAssertNotNil(error as? ApiError, "\(reply)")
            }
        }
    }

    func testALostTokenResponseIsRetriedOnce() async throws {
        AuthStub.routes[tokenPath] = (200, good)
        AuthStub.failures[tokenPath] = [.networkConnectionLost]
        let fresh = try await client().refresh(refreshToken: "r1", previous: previous)
        XCTAssertEqual(fresh.refreshToken, "r2")
        XCTAssertEqual(AuthStub.requests.filter { $0.hasPrefix(tokenPath) }.count, 2)
    }

    func testATokenRequestThatKeepsFailingIsTransient() async {
        AuthStub.failures[tokenPath] = [.notConnectedToInternet, .notConnectedToInternet]
        do {
            _ = try await client().refresh(refreshToken: "r1", previous: previous)
            XCTFail("expected a throw")
        } catch {
            XCTAssertNotNil(error as? ApiError)
        }
    }
}

final class ClientReauthenticationTests: XCTestCase {
    private let base = URL(string: "https://api.example.test")!

    override func setUp() {
        AuthStub.reset()
    }

    func testChat401RepeatsOnceAndYieldsTheReplyOnce() async throws {
        AuthStub.routes["/api/chat"] = (200, "data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"hi\"}\n\ndata: [DONE]\n\n")
        let client = ChatClient(baseURL: base, session: stubSession(), accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { _ in "new" }))
        var deltas: [String] = []
        for try await event in client.send(text: "hello", messageID: "m1") {
            if case .textDelta(_, let delta) = event {
                deltas.append(delta)
            }
        }
        XCTAssertEqual(deltas, ["hi"])
        XCTAssertEqual(AuthStub.requests, ["/api/chat Bearer old", "/api/chat Bearer new"])
    }

    func testAgenda401RepeatsOnce() async throws {
        AuthStub.routes["/api/agenda"] = (200, #"{"items":[]}"#)
        let client = AgendaClient(baseURL: base, session: stubSession(), accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { _ in "new" }))
        let items = try await client.agenda(from: Date(timeIntervalSince1970: 0), to: Date(timeIntervalSince1970: 60))
        XCTAssertEqual(items, [])
        XCTAssertEqual(AuthStub.requests, ["/api/agenda Bearer old", "/api/agenda Bearer new"])
    }

    private func agenda(_ subject: SessionManager) -> AgendaClient {
        AgendaClient(baseURL: base, session: stubSession(), accessToken: { try await subject.accessToken() }, reauthenticate: Reauthenticator(
            fresh: { try await subject.accessToken(replacing: $0) },
            rejected: { try? await subject.signOut(rejecting: $0) }
        ))
    }

    private func loadAgenda(_ client: AgendaClient) async throws {
        _ = try await client.agenda(from: Date(timeIntervalSince1970: 0), to: Date(timeIntervalSince1970: 60))
    }

    func testA401OnAFreshlyRefreshedTokenSignsOut() async throws {
        AuthStub.routes["/api/agenda"] = (401, "{}")
        let (subject, store) = try manager(saved: session("a1")) { _ in session("a2", refresh: "r2") }
        do {
            try await loadAgenda(agenda(subject))
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unauthenticated)
        }
        let signedIn = try await subject.isSignedIn()
        XCTAssertFalse(signedIn)
        XCTAssertNil(try store.load())
        XCTAssertEqual(AuthStub.requests, ["/api/agenda Bearer a1", "/api/agenda Bearer a2"])
    }

    func testAServerFailureAfterTheRefreshKeepsTheSession() async throws {
        AuthStub.routes["/api/agenda"] = (500, "{}")
        let (subject, _) = try manager(saved: session("old")) { _ in session("a2", refresh: "r2") }
        try? await loadAgenda(agenda(subject))
        let signedIn = try await subject.isSignedIn()
        XCTAssertTrue(signedIn)
    }

    func testAFailedRefreshKeepsTheSession() async throws {
        AuthStub.routes["/api/agenda"] = (401, "{}")
        let (subject, _) = try manager(saved: session("a1")) { _ in throw ApiError.upstream }
        try? await loadAgenda(agenda(subject))
        let signedIn = try await subject.isSignedIn()
        XCTAssertTrue(signedIn)
        XCTAssertEqual(AuthStub.requests, ["/api/agenda Bearer a1"])
    }

    func testARejectionOfAnOlderTokenDoesNotSignOutANewerSession() async throws {
        let (subject, _) = try manager(saved: session("a2")) { _ in throw ApiError.upstream }
        try await subject.signOut(rejecting: "a1")
        let signedIn = try await subject.isSignedIn()
        XCTAssertTrue(signedIn)
    }
}
