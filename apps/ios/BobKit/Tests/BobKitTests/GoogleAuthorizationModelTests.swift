import XCTest
@testable import BobKit

@MainActor final class GoogleAuthorizationModelTests: XCTestCase {
    func testSuccessfulReturnCompletesThenPublishesAccount() async {
        let fixture = AuthorizationFixture()
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .completed)
        XCTAssertEqual(fixture.model.connectedAccount?.id, fixture.account.id)
        XCTAssertEqual(fixture.service.completions, 1)
    }

    func testSpoofedCallbackNeverCompletesAndInvalidatesAttempt() async {
        let fixture = AuthorizationFixture()
        fixture.browser.response = URL(string: "xyz.heybob.oauth://google/callback?state=\(String(repeating: "x", count: 43))&outcome=returned")!
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.service.completions, 0)
        XCTAssertEqual(fixture.service.cancellations, 1)
        XCTAssertEqual(fixture.model.state, .failed)
    }

    func testLogoutWhileBrowserOpenCannotCompleteOrPublishSuccess() async {
        let fixture = AuthorizationFixture()
        fixture.browser.held = true
        let request = Task { await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil) }
        await fixture.browser.waitUntilOpened()
        fixture.current = false
        fixture.browser.finish()
        await request.value
        XCTAssertEqual(fixture.service.completions, 0)
        XCTAssertNil(fixture.model.connectedAccount)
        XCTAssertEqual(fixture.model.state, .cancelled)
    }

    func testAccountSwitchDuringCompletionSuppressesResult() async {
        let fixture = AuthorizationFixture()
        fixture.service.beforeComplete = { fixture.current = false }
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertNil(fixture.model.connectedAccount)
        XCTAssertEqual(fixture.model.state, .cancelled)
    }

    func testOfflineCompletionRetainsProofForExplicitRecoveryWithoutNewConsent() async {
        let fixture = AuthorizationFixture()
        fixture.service.failNextCompletion = true
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .retryable)
        await fixture.model.retryCompletion()
        XCTAssertEqual(fixture.model.state, .completed)
        XCTAssertEqual(fixture.service.authorizations, 1)
        XCTAssertEqual(fixture.service.completions, 2)
        XCTAssertEqual(fixture.browser.opens, 1)
    }

    func testCancelRacingCommittedLinkShowsActualCompletedResult() async {
        let fixture = AuthorizationFixture()
        fixture.service.failNextCompletion = true
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        fixture.service.cancelResult = .completed(fixture.account)
        await fixture.model.cancel()
        XCTAssertEqual(fixture.model.state, .completed)
        XCTAssertEqual(fixture.model.connectedAccount?.id, fixture.account.id)
    }

    func testExpiredAttemptNeverOpensBrowser() async {
        let fixture = AuthorizationFixture()
        fixture.service.expired = true
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .expired)
        XCTAssertEqual(fixture.browser.opens, 0)
        XCTAssertEqual(fixture.service.completions, 0)
    }

    func testBrowserStartFailureAndCancellationDoNotComplete() async {
        for error in [ApiError.cancelled, .unknown(status: 0)] {
            let fixture = AuthorizationFixture()
            fixture.browser.failure = error
            await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
            XCTAssertEqual(fixture.service.completions, 0)
            XCTAssertEqual(fixture.service.cancellations, 1)
        }
    }

    func testCancellationFailureRetriesCancellationWithoutCompletingConsent() async {
        let fixture = AuthorizationFixture()
        fixture.browser.failure = .cancelled
        fixture.service.failNextCancellation = true
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .retryable)
        await fixture.model.retryCompletion()
        XCTAssertEqual(fixture.model.state, .cancelled)
        XCTAssertEqual(fixture.service.completions, 0)
        XCTAssertEqual(fixture.service.cancellations, 2)
    }

    func testMissingCancellationAttemptIsTerminalAndDoesNotTrapSheet() async {
        let fixture = AuthorizationFixture()
        fixture.browser.failure = .cancelled
        fixture.service.cancellationError = .notFound
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .failed)
        fixture.service.cancellationError = nil
        fixture.browser.failure = nil
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .completed)
    }

    func testOfflineCancellationCanBeExplicitlyLeftWithoutClaimingCompletion() async {
        let fixture = AuthorizationFixture()
        fixture.browser.failure = .cancelled
        fixture.service.cancellationError = .offline
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .retryable)
        fixture.model.invalidate()
        XCTAssertFalse(fixture.model.busy)
        XCTAssertEqual(fixture.model.state, .cancelled)
        XCTAssertNil(fixture.model.connectedAccount)
        XCTAssertEqual(fixture.service.completions, 0)
    }

    func testProcessingRecoversCompletionWithoutOpeningAnotherBrowser() async {
        let fixture = AuthorizationFixture()
        fixture.service.processingResponses = 2
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .completed)
        XCTAssertEqual(fixture.service.completions, 3)
        XCTAssertEqual(fixture.browser.opens, 1)
    }

    func testProcessingLoopIsBoundedAndCanBeExplicitlyRetried() async {
        let fixture = AuthorizationFixture()
        fixture.service.processingResponses = 100
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .retryable)
        XCTAssertEqual(fixture.service.completions, 60)
        fixture.service.processingResponses = 0
        await fixture.model.retryCompletion()
        XCTAssertEqual(fixture.model.state, .completed)
    }

    func testCancelDuringAuthorizeCleansUpLateAttemptWithoutOpeningBrowser() async {
        let fixture = AuthorizationFixture()
        fixture.service.holdAuthorization = true
        let request = Task { await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil) }
        await fixture.service.waitForAuthorization()
        await fixture.model.cancel()
        fixture.service.releaseAuthorization()
        await request.value
        XCTAssertEqual(fixture.model.state, .cancelled)
        XCTAssertEqual(fixture.browser.opens, 0)
        XCTAssertEqual(fixture.service.cancellations, 1)
    }

    func testExpiryRecoveryPreservesAlreadyCommittedResult() async {
        let fixture = AuthorizationFixture()
        fixture.service.expired = true
        fixture.service.cancelResult = .completed(fixture.account)
        await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil)
        XCTAssertEqual(fixture.model.state, .completed)
        XCTAssertEqual(fixture.browser.opens, 0)
    }

    func testDuplicateConnectWhileBrowserActiveDoesNotCreateAnotherAttempt() async {
        let fixture = AuthorizationFixture()
        fixture.browser.held = true
        let request = Task { await fixture.model.connect(capabilities: [.calendarRead], reconnectAccountID: nil) }
        await fixture.browser.waitUntilOpened()
        await fixture.model.connect(capabilities: [.mailSend], reconnectAccountID: nil)
        XCTAssertEqual(fixture.service.authorizations, 1)
        await fixture.model.cancel()
        await request.value
        XCTAssertEqual(fixture.model.state, .cancelled)
    }
}

@MainActor private final class AuthorizationFixture {
    let account = GoogleIntegrationAccount(id: "11111111-1111-4111-8111-111111111111", email: "person@example.test", selected: true, createdAt: Date(), access: [.calendarRead], needsReconnect: false)
    let browser = AuthorizationBrowser()
    lazy var service = AuthorizationService(account: account)
    var current = true
    lazy var model = GoogleAuthorizationModel(browser: browser, sleep: { _ in }, context: { [self] in
        GoogleAuthorizationContext(service: service, isCurrent: { @MainActor [self] in current })
    })
}

@MainActor private final class AuthorizationService: GoogleAuthorizationService {
    let account: GoogleIntegrationAccount
    var authorizations = 0
    var completions = 0
    var cancellations = 0
    var failNextCompletion = false
    var failNextCancellation = false
    var cancellationError: ApiError?
    var processingResponses = 0
    var holdAuthorization = false
    private var authorizationGate: CheckedContinuation<Void, Never>?
    private var authorizationEntered: CheckedContinuation<Void, Never>?
    var expired = false
    var cancelResult: GoogleAuthorizationResult = .cancelled
    var beforeComplete: (() -> Void)?
    init(account: GoogleIntegrationAccount) { self.account = account }
    func authorize(capabilities: [GoogleCapability], reconnectAccountID: String?, challenge: String) async throws -> GoogleAuthorizationAttempt {
        authorizations += 1
        if holdAuthorization {
            await withCheckedContinuation { authorizationGate = $0; authorizationEntered?.resume(); authorizationEntered = nil }
        }
        return GoogleAuthorizationAttempt(id: account.id, state: String(repeating: "s", count: 43), url: URL(string: "https://provider.test")!, expiresAt: Date().addingTimeInterval(expired ? -1 : 600))
    }
    func waitForAuthorization() async {
        if authorizationGate != nil { return }
        await withCheckedContinuation { authorizationEntered = $0 }
    }
    func releaseAuthorization() { authorizationGate?.resume(); authorizationGate = nil }
    func complete(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult {
        completions += 1
        beforeComplete?()
        if processingResponses > 0 { processingResponses -= 1; return .processing(retryAfterMilliseconds: 1000) }
        if failNextCompletion { failNextCompletion = false; throw ApiError.offline }
        return .completed(account)
    }
    func cancel(attempt: GoogleAuthorizationAttempt, proof: GoogleAuthorizationProof) async throws -> GoogleAuthorizationResult {
        cancellations += 1
        if let cancellationError { throw cancellationError }
        if failNextCancellation { failNextCancellation = false; throw ApiError.offline }
        return cancelResult
    }
}

@MainActor private final class AuthorizationBrowser: GoogleAuthorizationBrowser {
    var held = false
    var opens = 0
    var failure: ApiError?
    var response = URL(string: "xyz.heybob.oauth://google/callback?state=\(String(repeating: "s", count: 43))&outcome=returned")!
    private var pending: CheckedContinuation<URL, Error>?
    private var entered: CheckedContinuation<Void, Never>?
    func open(_ url: URL) async throws -> URL {
        opens += 1
        if let failure { throw failure }
        if held {
            return try await withCheckedThrowingContinuation { pending = $0; entered?.resume(); entered = nil }
        }
        return response
    }
    func waitUntilOpened() async {
        if pending != nil { return }
        await withCheckedContinuation { entered = $0 }
    }
    func finish() { pending?.resume(returning: response); pending = nil }
    func cancel() { pending?.resume(throwing: ApiError.cancelled); pending = nil }
}
