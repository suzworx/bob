import XCTest
@testable import BobKit

private final class SignInStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: (Int, String) = (200, "{}")
    nonisolated(unsafe) static var failure: URLError.Code?
    nonisolated(unsafe) static var seen: URLRequest?
    nonisolated(unsafe) static var body: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        var (status, text) = (200, #"{"supabaseUrl":"https://db.example.test","supabasePublishableKey":"sb_publishable_x"}"#)
        if url.path.hasPrefix("/auth/") {
            Self.seen = request
            Self.body = Self.read(request)
            if let failure = Self.failure {
                client?.urlProtocol(self, didFailWithError: URLError(failure))
                return
            }
            (status, text) = Self.reply
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    // URLSession moves httpBody into a stream before a URLProtocol sees the request.
    private static func read(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else {
            return request.httpBody
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class SignInClientTests: XCTestCase {
    private func client() -> SupabaseAuthClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SignInStub.self]
        return SupabaseAuthClient(apiBaseURL: URL(string: "https://api.example.test")!, session: URLSession(configuration: configuration), now: { Date(timeIntervalSince1970: 1000) })
    }

    private func sentBody() throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(SignInStub.body)) as? NSDictionary)
    }

    private func requestError(_ reply: (Int, String)) async -> SignInError? {
        SignInStub.reply = reply
        do {
            try await client().requestCode(email: "a@b.co")
            return nil
        } catch {
            return error as? SignInError
        }
    }

    private func verifyError(_ reply: (Int, String)) async -> SignInError? {
        SignInStub.reply = reply
        do {
            _ = try await client().verifyCode(email: "a@b.co", code: "123456")
            return nil
        } catch {
            return error as? SignInError
        }
    }

    override func setUp() {
        SignInStub.reply = (200, "{}")
        SignInStub.failure = nil
        SignInStub.seen = nil
        SignInStub.body = nil
    }

    func testRequestCodeSendsTheInviteOnlyBodyAndThePublicKey() async throws {
        try await client().requestCode(email: "a@b.co")
        XCTAssertEqual(SignInStub.seen?.url?.absoluteString, "https://db.example.test/auth/v1/otp")
        XCTAssertEqual(SignInStub.seen?.httpMethod, "POST")
        XCTAssertEqual(SignInStub.seen?.value(forHTTPHeaderField: "apikey"), "sb_publishable_x")
        XCTAssertEqual(try sentBody(), ["email": "a@b.co", "create_user": false])
    }

    func testVerifyCodeSendsTheTokenAndParsesTheSession() async throws {
        SignInStub.reply = (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600,"user":{"id":"u1"}}"#)
        let session = try await client().verifyCode(email: "a@b.co", code: "123456")
        XCTAssertEqual(session, StoredSession(accessToken: "a1", refreshToken: "r1", expiresAt: Date(timeIntervalSince1970: 4600), userID: "u1"))
        XCTAssertEqual(SignInStub.seen?.url?.absoluteString, "https://db.example.test/auth/v1/verify")
        XCTAssertEqual(SignInStub.seen?.value(forHTTPHeaderField: "apikey"), "sb_publishable_x")
        XCTAssertEqual(try sentBody(), ["type": "email", "email": "a@b.co", "token": "123456"])
    }

    func testVerifyWithoutAUserOrTokenIsAFailure() async {
        let error = await verifyError((200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#))
        XCTAssertEqual(error, .failed)
    }

    func testWrongOrExpiredCode() async {
        var error = await verifyError((403, #"{"error_code":"otp_expired","msg":"Token has expired or is invalid"}"#))
        XCTAssertEqual(error, .badCode)
        error = await verifyError((403, "{}"))
        XCTAssertEqual(error, .badCode)
        error = await verifyError((400, #"{"error_code":"otp_expired"}"#))
        XCTAssertEqual(error, .badCode)
    }

    func testUnknownAddress() async {
        for reply in [(422, #"{"error_code":"otp_disabled"}"#), (400, #"{"error_code":"signup_disabled"}"#), (404, #"{"error_code":"user_not_found"}"#), (422, "{}")] {
            let error = await requestError(reply)
            XCTAssertEqual(error, .unknownAddress, "\(reply)")
        }
    }

    func testRateLimitsAreToldApart() async {
        var error = await requestError((429, #"{"error_code":"over_email_send_rate_limit","msg":"For security purposes, you can only request this after 42 seconds."}"#))
        XCTAssertEqual(error, .cooldown(seconds: 42))
        error = await requestError((429, #"{"error_code":"over_email_send_rate_limit","message":"you can only request this after 1 second"}"#))
        XCTAssertEqual(error, .cooldown(seconds: 1))
        error = await requestError((429, #"{"error_code":"over_email_send_rate_limit","msg":"Email rate limit exceeded"}"#))
        XCTAssertEqual(error, .emailCap)
        error = await requestError((429, #"{"error_code":"over_request_rate_limit"}"#))
        XCTAssertEqual(error, .tooManyAttempts)
        error = await verifyError((429, "not json"))
        XCTAssertEqual(error, .tooManyAttempts)
    }

    func testEverythingElseIsNeutralOrUnreachable() async {
        var error = await requestError((400, #"{"error_code":"bad_json"}"#))
        XCTAssertEqual(error, .failed)
        error = await requestError((503, "<html>"))
        XCTAssertEqual(error, .unreachable)
        SignInStub.failure = .notConnectedToInternet
        error = await requestError((200, "{}"))
        XCTAssertEqual(error, .unreachable)
    }
}

final class SignInFlowTests: XCTestCase {
    func testAFullCodeAutoVerifiesOnce() {
        var flow = SignInFlow()
        flow.setEmail("a@example.com")
        _ = flow.startSend(now: Date(timeIntervalSince1970: 0))
        flow.finishSend(error: nil, now: Date(timeIntervalSince1970: 0))
        flow.setCode("12345")
        XCTAssertFalse(flow.shouldAutoVerify)
        flow.setCode("123456")
        XCTAssertTrue(flow.shouldAutoVerify)
        _ = flow.startVerify()
        XCTAssertFalse(flow.shouldAutoVerify)
        flow.finishVerify(error: .badCode)
        XCTAssertFalse(flow.shouldAutoVerify)
    }

    func testTypingANewCodeClearsTheOldError() {
        var flow = SignInFlow()
        flow.setEmail("a@example.com")
        _ = flow.startSend(now: Date(timeIntervalSince1970: 0))
        flow.finishSend(error: nil, now: Date(timeIntervalSince1970: 0))
        flow.setCode("123456")
        _ = flow.startVerify()
        flow.finishVerify(error: .badCode)
        XCTAssertNotNil(flow.errorMessage)
        flow.setCode("1")
        XCTAssertNil(flow.errorMessage)
    }

    private let start = Date(timeIntervalSince1970: 1000)

    private func sent() -> SignInFlow {
        var flow = SignInFlow()
        flow.setEmail("a@b.co")
        _ = flow.startSend(now: start)
        flow.finishSend(error: nil, now: start)
        return flow
    }

    func testEmailIsCheckedLocallyBeforeSending() {
        var flow = SignInFlow()
        XCTAssertNil(flow.startSend(now: start))
        XCTAssertEqual(flow.emailProblem, "Enter your email address first.")
        flow.setEmail("nope")
        XCTAssertNil(flow.emailProblem)
        XCTAssertNil(flow.startSend(now: start))
        XCTAssertEqual(flow.emailProblem, "Enter a valid email address, like you@example.com.")
        XCTAssertFalse(flow.isSending)
    }

    func testSendTrimsTheEmailAndShowsSendingUntilItFinishes() {
        var flow = SignInFlow()
        flow.setEmail("  a@b.co ")
        XCTAssertEqual(flow.startSend(now: start), "a@b.co")
        XCTAssertTrue(flow.isSending)
        XCTAssertNil(flow.startSend(now: start))
        flow.finishSend(error: nil, now: start)
        XCTAssertFalse(flow.isSending)
        XCTAssertEqual(flow.step, .code)
        XCTAssertEqual(flow.notice, "We emailed you a six-digit code.")
    }

    func testAnUnknownAddressLooksExactlyLikeASentCode() {
        var flow = SignInFlow()
        flow.setEmail("a@b.co")
        _ = flow.startSend(now: start)
        flow.finishSend(error: .unknownAddress, now: start)
        XCTAssertEqual(flow, sent())
    }

    func testResendWaitsOutTheCooldown() {
        var flow = sent()
        XCTAssertEqual(flow.resendSecondsRemaining(now: start), 60)
        XCTAssertEqual(flow.resendSecondsRemaining(now: start.addingTimeInterval(59.5)), 1)
        XCTAssertNil(flow.startSend(now: start.addingTimeInterval(59)))
        XCTAssertEqual(flow.resendSecondsRemaining(now: start.addingTimeInterval(60)), 0)
        XCTAssertEqual(flow.startSend(now: start.addingTimeInterval(60)), "a@b.co")
    }

    func testAServerCooldownOpensCodeEntryAndSetsTheWait() {
        var flow = SignInFlow()
        flow.setEmail("a@b.co")
        _ = flow.startSend(now: start)
        flow.finishSend(error: .cooldown(seconds: 42), now: start)
        XCTAssertEqual(flow.step, .code)
        XCTAssertEqual(flow.resendSecondsRemaining(now: start), 42)
        XCTAssertEqual(flow.errorMessage, "Wait 42 seconds, then request a new code.")
        XCTAssertNil(flow.notice)
        XCTAssertNil(flow.retryAction)
    }

    func testChangingTheAddressStartsOver() {
        var flow = sent()
        flow.setCode("123456")
        flow.setEmail("c@d.co")
        XCTAssertEqual(flow.step, .email)
        XCTAssertEqual(flow.code, "")
        XCTAssertEqual(flow.resendSecondsRemaining(now: start), 0)
    }

    func testCodeKeepsSixDigitsAndMustBeComplete() {
        var flow = sent()
        flow.setCode("12a")
        XCTAssertEqual(flow.code, "12")
        XCTAssertNil(flow.startVerify())
        XCTAssertEqual(flow.codeProblem, "Enter the 6-digit code from your email.")
        flow.setCode("1234567")
        XCTAssertEqual(flow.code, "123456")
        let started = flow.startVerify()
        XCTAssertEqual(started?.email, "a@b.co")
        XCTAssertEqual(started?.code, "123456")
        XCTAssertTrue(flow.isSending)
    }

    func testABadCodeClearsTheFieldAndHasNoBlindRetry() {
        var flow = sent()
        flow.setCode("123456")
        _ = flow.startVerify()
        flow.finishVerify(error: .badCode)
        XCTAssertEqual(flow.code, "")
        XCTAssertEqual(flow.errorMessage, "That code is wrong or has expired. Request a new code.")
        XCTAssertNil(flow.retryAction)
    }

    func testAFailureThatCanWorkLaterOffersRetryOfTheSameAction() {
        var flow = SignInFlow()
        flow.setEmail("a@b.co")
        _ = flow.startSend(now: start)
        flow.finishSend(error: .unreachable, now: start)
        XCTAssertEqual(flow.step, .email)
        XCTAssertEqual(flow.retryAction, .send)
        flow = sent()
        flow.setCode("123456")
        _ = flow.startVerify()
        flow.finishVerify(error: .unreachable)
        XCTAssertEqual(flow.code, "123456")
        XCTAssertEqual(flow.retryAction, .verify)
    }

    func testPastedLettersAndAnExtraDigitLeaveOnlySixDigitsSoBackspaceRemovesOne() {
        XCTAssertEqual(SignInFlow.cleanCode("12-a 3"), "123")
        var flow = sent()
        flow.setCode("1234567")
        XCTAssertEqual(flow.code, "123456")
        flow.setCode(String(flow.code.dropLast()))
        XCTAssertEqual(flow.code, "12345")
    }

    func testTheCodeCannotChangeWhileVerifying() {
        var flow = sent()
        flow.setCode("123456")
        _ = flow.startVerify()
        flow.setCode("1")
        XCTAssertEqual(flow.code, "123456")
    }

    func testFocusIsRequestedWhenCodeEntryAppearsAndAfterABadCode() {
        var flow = SignInFlow()
        XCTAssertEqual(flow.codeFocusRequests, 0)
        flow.setEmail("a@b.co")
        _ = flow.startSend(now: start)
        flow.finishSend(error: .unreachable, now: start)
        XCTAssertEqual(flow.codeFocusRequests, 0)
        _ = flow.startSend(now: start)
        flow.finishSend(error: nil, now: start)
        XCTAssertEqual(flow.codeFocusRequests, 1)
        flow.setCode("123456")
        _ = flow.startVerify()
        flow.finishVerify(error: .badCode)
        XCTAssertEqual(flow.codeFocusRequests, 2)
    }
}

@MainActor
final class SessionGateTests: XCTestCase {
    private let stored = StoredSession(accessToken: "a1", refreshToken: "r1", expiresAt: .distantFuture, userID: "u1")

    private func manager(_ backing: InMemorySecureStore, refresher: @escaping SessionManager.Refresher = { _ in throw SessionRefreshError.revoked }) -> SessionManager {
        SessionManager(store: SessionStore(store: backing), refresher: refresher)
    }

    private func backing(saved: StoredSession?) throws -> InMemorySecureStore {
        let backing = InMemorySecureStore()
        if let saved {
            try SessionStore(store: backing).save(saved)
        }
        return backing
    }

    func testStartsCheckingAndNoManagerIsSignedIn() async {
        let gate = SessionGate(manager: nil)
        XCTAssertEqual(gate.state, .checking)
        await gate.check()
        XCTAssertEqual(gate.state, .signedIn)
    }

    func testAStoredSessionIsSignedIn() async throws {
        let gate = SessionGate(manager: manager(try backing(saved: stored)))
        await gate.check()
        XCTAssertEqual(gate.state, .signedIn)
    }

    func testNoSessionIsSignedOut() async throws {
        let gate = SessionGate(manager: manager(try backing(saved: nil)))
        await gate.check()
        XCTAssertEqual(gate.state, .signedOut)
    }

    func testALockedStoreStaysSignedIn() async throws {
        let locked = try backing(saved: stored)
        locked.isAvailable = false
        let gate = SessionGate(manager: manager(locked))
        await gate.check()
        XCTAssertEqual(gate.state, .signedIn)
    }

    func testADeadSessionReturnsToSignedOut() async throws {
        let subject = manager(try backing(saved: stored))
        let gate = SessionGate(manager: subject)
        await gate.check()
        XCTAssertEqual(gate.state, .signedIn)
        let token = try await subject.accessToken(replacing: "a1")
        XCTAssertNil(token)
        await gate.check()
        XCTAssertEqual(gate.state, .signedOut)
    }

    func testSignInMovesToSignedIn() async throws {
        let gate = SessionGate(manager: manager(try backing(saved: nil)))
        await gate.check()
        try await gate.signIn(stored)
        XCTAssertEqual(gate.state, .signedIn)
    }

    func testLogoutHookRunsBeforeStoredAuthenticationIsCleared() async throws {
        let subject = manager(try backing(saved: stored))
        let gate = SessionGate(manager: subject, beforeSignOut: {
            let token = try? await subject.accessToken()
            XCTAssertEqual(token, "a1")
        })
        await gate.check()
        await gate.signOut()
        let remaining = try await subject.userID()
        XCTAssertNil(remaining)
        XCTAssertEqual(gate.state, .signedOut)
    }

    func testNewSignInWhileLogoutHookWaitsCannotBeClearedByOldLogout() async throws {
        let subject = manager(try backing(saved: stored))
        let wait = SessionLogoutWait()
        let gate = SessionGate(manager: subject, beforeSignOut: { await wait.hold() })
        await gate.check()
        let oldLogout = Task { await gate.signOut() }
        await wait.waitUntilStarted()
        let replacement = StoredSession(accessToken: "b1", refreshToken: "br1", expiresAt: .distantFuture, userID: "u2")
        try await gate.signIn(replacement)
        wait.release()
        await oldLogout.value
        let userID = try await subject.userID()
        XCTAssertEqual(userID, "u2")
        XCTAssertEqual(gate.state, .signedIn)
    }

    func testNewSignInSupersedesSignedOutCheckCleanup() async throws {
        let subject = manager(try backing(saved: nil))
        let wait = SessionLogoutWait()
        let gate = SessionGate(manager: subject, beforeSignOut: { await wait.hold() })
        let oldCheck = Task { await gate.check() }
        await wait.waitUntilStarted()
        try await gate.signIn(stored)
        wait.release()
        await oldCheck.value
        XCTAssertEqual(gate.state, .signedIn)
    }
}

@MainActor private final class SessionLogoutWait {
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func hold() async {
        await withCheckedContinuation { continuation = $0; waiter?.resume(); waiter = nil }
    }
    func waitUntilStarted() async {
        if continuation == nil { await withCheckedContinuation { waiter = $0 } }
    }
    func release() { continuation?.resume(); continuation = nil }
}
