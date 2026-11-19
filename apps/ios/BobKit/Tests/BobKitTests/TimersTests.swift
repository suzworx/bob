import XCTest
@testable import BobKit

private let timerID = "11111111-1111-4111-8111-111111111111"
private let timerJSON = #"{"id":"11111111-1111-4111-8111-111111111111","kind":"timer","label":"Tea","fire_at":1,"remaining_ms":65000,"zone":"UTC"}"#

final class TimersClientTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> TimersClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        return TimersClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), accessToken: { token })
    }
    func testListUsesAuthenticatedServerDurationAndCancelChecksReceipt() async throws {
        ProductivityStub.route("GET /api/timers", 200, "{\"timers\":[\(timerJSON)]}")
        let timers = try await client().list()
        XCTAssertEqual(timers.first?.remainingMilliseconds, 65_000)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        ProductivityStub.route("DELETE /api/timers/\(timerID)", 200, "{\"cancelled\":\(timerJSON),\"remaining\":0}")
        try await client().cancel(id: timerID)
        XCTAssertNil(ProductivityStub.last?.body)
        ProductivityStub.route("DELETE /api/timers/\(timerID)", 200, #"{"ok":true}"#)
        do { try await client().cancel(id: timerID); XCTFail("Malformed success is not cancellation") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testAlreadyGoneCancellationSucceedsButOfflineRefusalDoesNot() async throws {
        ProductivityStub.route("DELETE /api/timers/\(timerID)", 404, #"{"error":{"code":"not_found"}}"#)
        try await client().cancel(id: timerID)
        ProductivityStub.route("DELETE /api/timers/\(timerID)", 503, #"{"error":{"code":"unavailable"}}"#)
        do { try await client().cancel(id: timerID); XCTFail() } catch { XCTAssertNotEqual(error as? ApiError, .notFound) }
    }
    func testMissingSessionAndInvalidIDNeverSend() async {
        do { _ = try await client(token: nil).list(); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        do { try await client().cancel(id: "bad"); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testNotificationSnapshotAuthenticatesTracksIdsAndRequiresExplicitStates() async throws {
        let firedJSON = String(timerJSON.dropLast()) + #", "status":"fired"}"#
        ProductivityStub.route("GET /api/timers/notification-state", 200, "{\"timers\":[\(firedJSON)]}")
        let snapshot = try await client().notificationState(trackedIDs: [timerID])
        XCTAssertEqual(snapshot.first?.status, .fired)
        XCTAssertEqual(snapshot.first?.timer.remainingMilliseconds, 65_000)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(ProductivityStub.last?.query, "ids=\(timerID)")
        do { _ = try await client().notificationState(trackedIDs: []); XCTFail("Unrequested terminal history is invalid") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
        ProductivityStub.route("GET /api/timers/notification-state", 200, "{\"timers\":[\(timerJSON)]}")
        do { _ = try await client().notificationState(trackedIDs: [timerID]); XCTFail("Pending-only projection cannot masquerade as a state snapshot") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testInvalidOrTooManyTrackedIdsNeverSendAndUnavailableSnapshotIsNotEmpty() async {
        for ids in [["invalid"], Array(repeating: timerID, count: 61), [timerID, timerID]] {
            do { _ = try await client().notificationState(trackedIDs: ids); XCTFail() }
            catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        }
        XCTAssertNil(ProductivityStub.last)
        ProductivityStub.route("GET /api/timers/notification-state", 503, #"{"error":{"code":"unavailable"}}"#)
        do { _ = try await client().notificationState(trackedIDs: [timerID]); XCTFail() }
        catch { XCTAssertNotEqual(error as? ApiError, .notFound) }
    }
}

@MainActor final class TimersStateTests: XCTestCase {
    private func summary(milliseconds: Int = 65000) -> TimerSummary {
        TimerSummary(id: timerID, kind: .timer, label: "Tea", firesAt: Date(timeIntervalSince1970: 1), remainingMilliseconds: milliseconds, zone: "UTC")
    }
    func testCountdownUsesMonotonicDurationNotFireAtWallClock() async {
        let clock = TimerTestClock()
        let item = summary()
        let model = TimersModel(read: { [item] }, cancel: { _ in }, now: { clock.value })
        await model.refresh()
        XCTAssertEqual(model.timers.first?.countdown(at: model.now), "1:05")
        clock.value += 1.2
        await model.tick()
        XCTAssertEqual(model.timers.first?.countdown(at: model.now), "1:04")
        XCTAssertEqual(RunningTimer.format(milliseconds: 3_661_001), "1:01:02")
    }
    func testZeroExpiryReadIsBoundedEvenWhenServerAlwaysReturnsZero() async {
        let clock = TimerTestClock()
        let source = TimerTestSource(items: [summary(milliseconds: 0)])
        let model = TimersModel(read: { try await source.read() }, cancel: { _ in }, now: { clock.value })
        await model.refresh()
        for _ in 0..<100 { clock.value += 1; await model.tick() }
        let calls = await source.readCount()
        XCTAssertEqual(calls, 4, "Initial read plus three spaced expiry checks, never a busy loop")
        XCTAssertEqual(model.timers.first?.countdown(at: model.now), "0:00")
    }
    func testFailedCancelKeepsRowAndExplicitRetryCanRemoveIt() async {
        let source = TimerTestSource(items: [summary()], cancelFails: true)
        let model = TimersModel(read: { try await source.read() }, cancel: { try await source.cancel($0) })
        await model.refresh()
        await model.cancel(timerID)
        XCTAssertEqual(model.timers.count, 1)
        XCTAssertNotNil(model.actionError)
        await source.allowCancel()
        await model.cancel(timerID)
        XCTAssertTrue(model.timers.isEmpty)
        XCTAssertNil(model.actionError)
    }
    func testOfflineReadIsFailureRatherThanEmptyAndRetryWorks() async {
        let source = TimerTestSource(items: [summary()], readFails: true)
        let model = TimersModel(read: { try await source.read() }, cancel: { _ in })
        await model.refresh()
        XCTAssertEqual(model.phase, .failed(.offline))
        await source.allowRead()
        await model.refresh()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.timers.count, 1)
    }
    func testLateReadCannotResurrectCancelledTimer() async {
        let source = TimerTestSource(items: [summary()])
        let model = TimersModel(read: { try await source.read() }, cancel: { try await source.cancel($0) })
        await model.refresh()
        await source.holdNextRead()
        let read = Task { await model.refresh() }
        await source.waitForRead()
        await model.cancel(timerID)
        await source.releaseRead()
        await read.value
        XCTAssertTrue(model.timers.isEmpty)
    }
}

@MainActor private final class TimerTestClock { var value: TimeInterval = 100 }
private actor TimerTestSource {
    private let items: [TimerSummary]
    private var calls = 0
    private var cancelFails: Bool
    private var readFails: Bool
    private var hold = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    init(items: [TimerSummary], cancelFails: Bool = false, readFails: Bool = false) { self.items = items; self.cancelFails = cancelFails; self.readFails = readFails }
    func read() async throws -> [TimerSummary] {
        calls += 1
        if hold { await withCheckedContinuation { continuation = $0; waiter?.resume(); waiter = nil } }
        if readFails { throw ApiError.offline }
        return items
    }
    func cancel(_ id: String) throws { if cancelFails { throw ApiError.offline } }
    func allowCancel() { cancelFails = false }
    func allowRead() { readFails = false }
    func readCount() -> Int { calls }
    func holdNextRead() { hold = true }
    func waitForRead() async { if continuation == nil { await withCheckedContinuation { waiter = $0 } } }
    func releaseRead() { hold = false; continuation?.resume(); continuation = nil }
}
