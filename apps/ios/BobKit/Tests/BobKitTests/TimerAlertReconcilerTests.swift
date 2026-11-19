import Foundation
import XCTest
@testable import BobKit

@MainActor final class TimerAlertReconcilerTests: XCTestCase {
    private func timer(_ id: String = "timer", milliseconds: Int = 30_000, fire: TimeInterval = 1_000, status: TimerNotificationState.Status = .pending) -> TimerNotificationState {
        TimerNotificationState(timer: TimerSummary(id: id, kind: .timer, label: "Tea", firesAt: Date(timeIntervalSince1970: fire), remainingMilliseconds: milliseconds, zone: "UTC"), status: status)
    }

    func testAuthoritativeSnapshotSchedulesRelativeDelayAndDeduplicates() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler, now: { 0 })
        let row = timer()
        await subject.refresh(accountID: "A", read: { _ in [row] })
        XCTAssertEqual(scheduler.scheduled.count, 1)
        XCTAssertEqual(scheduler.scheduled.first?.delay, 30)
        XCTAssertEqual(scheduler.scheduled.first?.sourceFireAt, row.timer.firesAt)
        await subject.refresh(accountID: "A", read: { _ in [row] })
        XCTAssertEqual(scheduler.scheduled.count, 1)
        XCTAssertNotEqual(TimerAlert.identifier(accountID: "a:b", timerID: "c"), TimerAlert.identifier(accountID: "a", timerID: "b:c"))
    }

    func testEmptySuccessCancelsButFailurePreservesScheduledTimer() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let row = timer()
        await subject.refresh(accountID: "A", read: { _ in [row] })
        await subject.refresh(accountID: "A", read: { _ in throw CancellationError() })
        XCTAssertEqual(scheduler.requests.count, 1)
        await subject.refresh(accountID: "A", read: { _ in [] })
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testDueRowDoesNotCancelAlreadyScheduledAlert() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let active = timer(milliseconds: 1_000)
        await subject.refresh(accountID: "A", read: { _ in [active] })
        let due = timer(milliseconds: 0)
        await subject.refresh(accountID: "A", read: { _ in [due] })
        XCTAssertEqual(scheduler.requests.count, 1)
        XCTAssertEqual(scheduler.scheduled.count, 1)
    }

    func testServerFiresBeforeDelayedOSAlertAndTrackedSnapshotPreservesIt() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler, now: { 0 })
        let active = timer(milliseconds: 1_000)
        await subject.refresh(accountID: "A", read: { ids in
            XCTAssertTrue(ids.isEmpty)
            return [active]
        })
        let fired = timer(milliseconds: 0, status: .fired)
        await subject.refresh(accountID: "A", read: { ids in
            XCTAssertEqual(ids, [active.id])
            return [fired]
        })
        XCTAssertEqual(scheduler.requests.count, 1)
        XCTAssertEqual(scheduler.scheduled.count, 1)
        await subject.refresh(accountID: "A", read: { _ in throw ApiError.offline })
        XCTAssertEqual(scheduler.requests.count, 1)
        await subject.cancel(timerID: active.id, accountID: "A")
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testCancelledDismissedMissingOrChangedFiredDeadlineRemoveExistingRequest() async {
        for state in [timer(status: .cancelled), timer(status: .dismissed), timer(fire: 2_000, status: .fired)] {
            let scheduler = AlertSchedulerProbe()
            let subject = TimerAlertReconciler(scheduler: scheduler)
            let active = timer()
            await subject.refresh(accountID: "A", read: { _ in [active] })
            await subject.refresh(accountID: "A", read: { _ in [state] })
            XCTAssertTrue(scheduler.requests.isEmpty)
            XCTAssertEqual(scheduler.scheduled.count, 1)
        }
    }

    func testHistoricalFiredRowsNeverCreateAlertsAndLateFiredSnapshotCannotSurviveSignout() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let fired = timer(status: .fired)
        await subject.refresh(accountID: "A", read: { _ in [fired] })
        XCTAssertTrue(scheduler.scheduled.isEmpty)
        let active = timer()
        await subject.refresh(accountID: "A", read: { _ in [active] })
        let gate = AlertReadGate()
        let refresh = Task { await subject.refresh(accountID: "A", read: { _ in await gate.read() }) }
        await gate.waitUntilStarted()
        await subject.signOut()
        gate.finish([fired])
        await refresh.value
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testEarliestSixtyOnlyAndDueIgnored() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler, now: { 0 })
        let rows = (0...70).reversed().map { timer("t\($0)", milliseconds: $0 * 1_000) }
        await subject.refresh(accountID: "A", read: { _ in rows })
        XCTAssertEqual(scheduler.requests.count, 60)
        XCTAssertEqual(scheduler.scheduled.first?.timerID, "t1")
        XCTAssertEqual(scheduler.scheduled.last?.timerID, "t60")
    }

    func testRestoredPendingAndDeliveredDoNotRearmAndChangedDeadlineDoes() async {
        let scheduler = AlertSchedulerProbe()
        let original = timer()
        let first = TimerAlertReconciler(scheduler: scheduler)
        await first.refresh(accountID: "A", read: { _ in [original] })
        let restored = TimerAlertReconciler(scheduler: scheduler)
        await restored.refresh(accountID: "A", read: { _ in [original] })
        scheduler.receipts = scheduler.requests
        scheduler.requests = []
        await restored.refresh(accountID: "A", read: { _ in [original] })
        scheduler.receipts = [] // User dismisses the delivered notification.
        await restored.refresh(accountID: "A", read: { _ in [original] })
        XCTAssertEqual(scheduler.scheduled.count, 1)
        let updated = timer(fire: 2_000)
        await restored.refresh(accountID: "A", read: { _ in [updated] })
        XCTAssertEqual(scheduler.scheduled.count, 2)
    }

    func testCancellationCanRemovePersistedAlertBeforeFirstRefresh() async {
        let scheduler = AlertSchedulerProbe()
        let original = TimerAlertReconciler(scheduler: scheduler)
        let row = timer()
        await original.refresh(accountID: "A", read: { _ in [row] })
        let restored = TimerAlertReconciler(scheduler: scheduler)
        await restored.cancel(timerID: row.id, accountID: "A")
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testCancellationSupersedesInflightRead() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let gate = AlertReadGate()
        let row = timer()
        let old = Task { await subject.refresh(accountID: "A", read: { _ in await gate.read() }) }
        await gate.waitUntilStarted()
        await subject.cancel(timerID: row.id, accountID: "A")
        gate.finish([row])
        await old.value
        XCTAssertTrue(scheduler.requests.isEmpty)
        XCTAssertTrue(scheduler.scheduled.isEmpty)
    }

    func testSignoutSupersedesLateAddAndClearsDelivered() async {
        let scheduler = AlertSchedulerProbe()
        let add = AlertReadGate()
        scheduler.beforeAdd = { _ = await add.read() }
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let row = timer()
        let refresh = Task { await subject.refresh(accountID: "A", read: { _ in [row] }) }
        await add.waitUntilStarted()
        let signout = Task { await subject.signOut() }
        await Task.yield()
        add.finish([])
        await refresh.value
        await signout.value
        XCTAssertTrue(scheduler.requests.isEmpty)
        XCTAssertTrue(scheduler.receipts.isEmpty)
    }

    func testAccountTransitionClearsOldAccountEvenOnReadFailure() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler)
        let row = timer()
        await subject.refresh(accountID: "A", read: { _ in [row] })
        scheduler.receipts = scheduler.requests
        await subject.refresh(accountID: "B", read: { _ in throw CancellationError() })
        XCTAssertTrue(scheduler.requests.isEmpty)
        XCTAssertTrue(scheduler.receipts.isEmpty)
    }

    func testCapacityEvictionCanScheduleAgainWhenEarlierTimersAreGone() async {
        let scheduler = AlertSchedulerProbe()
        let subject = TimerAlertReconciler(scheduler: scheduler, now: { 0 })
        let late = timer("later", milliseconds: 90_000)
        await subject.refresh(accountID: "A", read: { _ in [late] })
        let earlier = (1...60).map { timer("t\($0)", milliseconds: $0 * 1_000) }
        await subject.refresh(accountID: "A", read: { _ in earlier + [late] })
        XCTAssertFalse(scheduler.requests.contains { $0.timerID == "later" })
        await subject.refresh(accountID: "A", read: { _ in [late] })
        XCTAssertEqual(scheduler.requests.map(\.timerID), ["later"])
    }

    func testOldDeliveredReceiptDoesNotOverrideNewPendingDeadline() async {
        let scheduler = AlertSchedulerProbe()
        let first = TimerAlertReconciler(scheduler: scheduler)
        let original = timer()
        await first.refresh(accountID: "A", read: { _ in [original] })
        scheduler.receipts = scheduler.requests
        let updated = timer(fire: 2_000)
        await first.refresh(accountID: "A", read: { _ in [updated] })
        let restored = TimerAlertReconciler(scheduler: scheduler)
        await restored.refresh(accountID: "A", read: { _ in [updated] })
        XCTAssertEqual(scheduler.scheduled.count, 2)
    }

    func testFailedAddRetriesAndElapsedSchedulingTimeIsSubtracted() async {
        let scheduler = AlertSchedulerProbe()
        let clock = AlertClock()
        let subject = TimerAlertReconciler(scheduler: scheduler, now: { clock.value })
        let row = timer()
        scheduler.fail = true
        await subject.refresh(accountID: "A", read: { _ in [row] })
        XCTAssertTrue(scheduler.requests.isEmpty)
        scheduler.fail = false
        scheduler.beforePending = { clock.value += 5 }
        await subject.refresh(accountID: "A", read: { _ in [row] })
        XCTAssertEqual(scheduler.requests.first?.delay, 25)
    }
}

@MainActor private final class AlertClock { var value: TimeInterval = 0 }

@MainActor private final class AlertSchedulerProbe: TimerAlertScheduling {
    var requests: [TimerAlert] = []
    var receipts: [TimerAlert] = []
    var scheduled: [TimerAlert] = []
    var beforeAdd: (() async -> Void)?
    var beforePending: (() -> Void)?
    var fail = false
    func pending() async -> [TimerAlert] { beforePending?(); return requests }
    func delivered() async -> [TimerAlert] { receipts }
    func schedule(_ alert: TimerAlert) async throws {
        await beforeAdd?()
        if fail { throw CancellationError() }
        requests.removeAll { $0.id == alert.id }
        requests.append(alert); scheduled.append(alert)
    }
    func remove(ids: [String]) async { requests.removeAll { ids.contains($0.id) } }
    func removeDelivered(ids: [String]) async { receipts.removeAll { ids.contains($0.id) } }
}

@MainActor private final class AlertReadGate {
    private var continuation: CheckedContinuation<[TimerNotificationState], Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func read() async -> [TimerNotificationState] {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            waiter?.resume(); waiter = nil
        }
    }
    func waitUntilStarted() async {
        if continuation != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func finish(_ rows: [TimerNotificationState]) { continuation?.resume(returning: rows); continuation = nil }
}
