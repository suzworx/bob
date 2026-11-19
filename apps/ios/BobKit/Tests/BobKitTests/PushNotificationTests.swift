import XCTest
@testable import BobKit

private let pushAccount = "11111111-1111-4111-8111-111111111111"
private let pushOther = "22222222-2222-4222-8222-222222222222"
private let pushResource = "33333333-3333-4333-8333-333333333333"

final class PushNotificationTests: XCTestCase {
    func testPayloadRejectsWrongVersionMalformedIDsAndCrossAccountUse() throws {
        let payload = try XCTUnwrap(BobPushNotification.decode(Data(#"{"version":1,"account_id":"\#(pushAccount)","kind":"timer","timer_id":"\#(pushResource)"}"#.utf8)))
        XCTAssertTrue(payload.belongs(to: pushAccount.uppercased()))
        XCTAssertFalse(payload.belongs(to: pushOther))
        XCTAssertEqual(payload.target, .calendar)
        XCTAssertNil(BobPushNotification.decode(Data(#"{"version":2,"account_id":"\#(pushAccount)","kind":"timer","timer_id":"\#(pushResource)"}"#.utf8)))
        XCTAssertNil(BobPushNotification.decode(Data(#"{"version":1,"account_id":"\#(pushAccount)","kind":"timer","timer_id":"https://evil.test"}"#.utf8)))
    }

    func testKnownResourceRoutesAreTypedAndUnknownResourcesFallBackToInbox() throws {
        func payload(_ type: String, space: String = "null") -> BobPushNotification? {
            BobPushNotification.decode(Data(#"{"version":1,"account_id":"\#(pushAccount)","kind":"notification","notification_id":"\#(pushOther)","resource_type":"\#(type)","resource_id":"\#(pushResource)","space_id":\#(space)}"#.utf8))
        }
        XCTAssertEqual(try XCTUnwrap(payload("task")).target, .task(pushResource))
        XCTAssertNil(try XCTUnwrap(payload("future_resource")).target)
        XCTAssertNil(try XCTUnwrap(payload("thread")).target)
        XCTAssertEqual(try XCTUnwrap(payload("thread", space: "\"\(pushOther)\"")).target, .thread(id: pushResource, spaceID: pushOther))
        XCTAssertNil(payload("task", space: "\"bad\""))
    }

    func testLocalCoverageRetainsDeliveredTimersForRemoteTTLAndPrioritizesPending() {
        let now = Date(timeIntervalSince1970: 1_000)
        func alert(_ id: String, account: String = pushAccount, at: TimeInterval) -> TimerAlert {
            TimerAlert(id: id, accountID: account, timerID: id, sourceFireAt: Date(timeIntervalSince1970: at), title: "Timer", delay: 1)
        }
        let current = alert(pushResource, at: 100)
        XCTAssertEqual(PushLocalTimerCoverage.identifiers(pending: [], retained: [current], accountID: pushAccount, now: now), [pushResource])
        XCTAssertTrue(PushLocalTimerCoverage.identifiers(pending: [], retained: [current], accountID: pushAccount, now: now.addingTimeInterval(1)).isEmpty)
        XCTAssertTrue(PushLocalTimerCoverage.identifiers(pending: [alert(pushResource, account: pushOther, at: 2_000)], retained: [], accountID: pushAccount, now: now).isEmpty)
        let pending = (0..<60).map { alert(String(format: "00000000-0000-4000-8000-%012d", $0), at: 2_000) }
        XCTAssertEqual(PushLocalTimerCoverage.identifiers(pending: pending, retained: [current], accountID: pushAccount, now: now), pending.map(\.timerID))
    }
}

final class PushClientTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client() -> PushClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        return PushClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), token: "captured-token")
    }
    private var registration: PushDeviceRegistration {
        PushDeviceRegistration(installationID: pushOther, token: String(repeating: "ab", count: 32), environment: .sandbox,
                               topic: "xyz.heybob.ios", appVersion: "1.0", localTimerIDs: [pushResource])
    }
    func testRegistrationSendsImmutableAuthenticationAndServerAvailabilityIsTruthful() async throws {
        ProductivityStub.route("POST /api/push/devices", 200, #"{"registered":true,"delivery_available":false}"#)
        let available = try await client().register(registration)
        XCTAssertFalse(available)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer captured-token")
        XCTAssertEqual(ProductivityStub.last?.body?["installation_id"] as? String, pushOther)
        XCTAssertEqual(ProductivityStub.last?.body?["local_timer_ids"] as? [String], [pushResource])
        ProductivityStub.route("DELETE /api/push/devices/\(pushOther)", 204, "")
        try await client().remove(installationID: pushOther)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
    }
    func testMalformedSuccessIsNeverRegistered() async {
        ProductivityStub.route("POST /api/push/devices", 200, #"{"registered":false,"delivery_available":true}"#)
        do { _ = try await client().register(registration); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
}

@MainActor final class PushRegistrationCoordinatorTests: XCTestCase {
    private var registration: PushDeviceRegistration {
        PushDeviceRegistration(installationID: pushResource, token: String(repeating: "ab", count: 32), environment: .sandbox,
                               topic: "xyz.heybob.ios", appVersion: "1.0", localTimerIDs: [])
    }
    func testLogoutWaitsForOldPostAndRemovesItBeforeNewAccountRegistration() async {
        let events = PushEvents()
        let gate = PushWait()
        let subject = PushRegistrationCoordinator()
        let old = PushRegistrationSession(accountID: pushAccount, register: { _ in
            events.values.append("postA")
            await gate.hold()
            return true
        }, remove: { _ in events.values.append("deleteA") })
        let newer = PushRegistrationSession(accountID: pushOther, register: { _ in
            events.values.append("postB"); return false
        }, remove: { _ in events.values.append("deleteB") })
        let first = Task { await subject.register(registration, session: old) }
        await gate.waitUntilStarted()
        let signout = Task { await subject.signOut() }
        await Task.yield()
        let next = Task { await subject.register(registration, session: newer) }
        await Task.yield()
        gate.release()
        await first.value; await signout.value; await next.value
        XCTAssertEqual(events.values, ["postA", "deleteA", "postB"])
        XCTAssertEqual(subject.deliveryAvailable, false)
        XCTAssertEqual(subject.accountID, pushOther)
    }

    func testFailedRemovalDoesNotBlockAccountSwitchOrUseNewAccountCredentials() async {
        let events = PushEvents()
        let subject = PushRegistrationCoordinator()
        let old = PushRegistrationSession(accountID: pushAccount, register: { _ in true }, remove: { _ in
            events.values.append("deleteA"); throw ApiError.offline
        })
        await subject.register(registration, session: old)
        let newer = PushRegistrationSession(accountID: pushOther, register: { _ in events.values.append("postB"); return true }, remove: { _ in events.values.append("deleteB") })
        await subject.register(registration, session: newer)
        XCTAssertEqual(events.values, ["deleteA", "postB"])
        XCTAssertEqual(subject.deliveryAvailable, true)
    }
}

@MainActor private final class PushEvents { var values: [String] = [] }
@MainActor private final class PushWait {
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
