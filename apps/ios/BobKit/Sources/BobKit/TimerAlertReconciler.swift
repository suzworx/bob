import Foundation

/// Mirrors Core's active timers into local alerts; Core remains the timer authority.
@MainActor public final class TimerAlertReconciler {
    public private(set) var errorMessage: String?
    private let scheduler: any TimerAlertScheduling
    private let now: @MainActor () -> TimeInterval
    private var accountID: String?
    private var generation = 0
    private var mutations: Task<Void, Never>?
    private var receipts: [String: Date] = [:]

    public init(scheduler: any TimerAlertScheduling, now: @escaping @MainActor () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.scheduler = scheduler
        self.now = now
    }

    public func refresh(accountID: String, read: @MainActor @Sendable ([String]) async throws -> [TimerNotificationState]) async {
        generation += 1
        let request = generation
        let changedAccount = self.accountID != accountID
        self.accountID = accountID
        errorMessage = nil
        if changedAccount {
            receipts = [:]
        }
        // Every refresh performs isolation cleanup, including one that supersedes the
        // first refresh before that refresh could clear the previous account.
        await enqueue { [self] in
            guard current(request) else { return }
            await clear(except: accountID)
        }
        guard current(request) else { return }
        do {
            let pending = await scheduler.pending()
            guard current(request) else { return }
            let trackedIDs = pending.filter { $0.accountID == accountID }.sorted { $0.sourceFireAt < $1.sourceFireAt }.prefix(60).map(\.timerID)
            let rows = try await read(trackedIDs)
            let received = now()
            guard current(request) else { return }
            await enqueue { [self] in
                guard current(request) else { return }
                await reconcile(rows, accountID: accountID, received: received, request: request)
            }
        } catch {
            if current(request) {
                errorMessage = "Bob couldn’t refresh timer alerts. Try again when you’re connected."
            }
        }
    }

    public func cancel(timerID: String, accountID: String) async {
        if self.accountID == accountID { generation += 1 }
        let identifier = TimerAlert.identifier(accountID: accountID, timerID: timerID)
        await enqueue { [self] in
            await scheduler.remove(ids: [identifier])
            await scheduler.removeDelivered(ids: [identifier])
            receipts[identifier] = nil
        }
    }

    public func signOut() async {
        generation += 1
        accountID = nil
        errorMessage = nil
        receipts = [:]
        await enqueue { [self] in await clear(except: nil) }
    }

    private func reconcile(_ states: [TimerNotificationState], accountID: String, received: TimeInterval, request: Int) async {
        let pending = await scheduler.pending()
        let delivered = await scheduler.delivered()
        guard current(request) else { return }
        let rows = states.filter { $0.status == .pending }.map(\.timer)
        for alert in pending + delivered where alert.accountID == accountID {
            if rows.contains(where: { $0.id == alert.timerID && $0.firesAt == alert.sourceFireAt }) {
                receipts[alert.id] = alert.sourceFireAt
            }
        }
        // Core can fire before the OS request due to network delay. Keep that
        // existing request only when Core confirms its unchanged fired deadline.
        // Never infer firing from an absent row or create an alert for history.
        let alreadyDue = pending.filter { alert in
            states.contains {
                $0.id == alert.timerID && $0.timer.firesAt == alert.sourceFireAt &&
                    ($0.status == .fired || ($0.status == .pending && $0.timer.remainingMilliseconds == 0))
            }
        }.map(\.id)
        let eligible = rows.filter { $0.remainingMilliseconds > 0 }.sorted {
            if $0.remainingMilliseconds == $1.remainingMilliseconds { return $0.id < $1.id }
            return $0.remainingMilliseconds < $1.remainingMilliseconds
        }.prefix(max(0, 60 - alreadyDue.count))
        let wanted = Set(eligible.map { TimerAlert.identifier(accountID: accountID, timerID: $0.id) } + alreadyDue)
        let removed = pending.filter { !wanted.contains($0.id) }.map(\.id)
        await scheduler.remove(ids: removed)
        for identifier in removed { receipts[identifier] = nil }
        guard current(request) else { return }
        // Keep receipts only for active rows; a changed source deadline is a new alert.
        let active = Set(rows.map { TimerAlert.identifier(accountID: accountID, timerID: $0.id) })
        receipts = receipts.filter { active.contains($0.key) }
        for row in eligible {
            guard current(request) else { return }
            let identifier = TimerAlert.identifier(accountID: accountID, timerID: row.id)
            guard receipts[identifier] != row.firesAt else { continue }
            let delay = Double(row.remainingMilliseconds) / 1_000 - max(0, now() - received)
            guard delay > 0 else { continue }
            let alert = TimerAlert(id: identifier, accountID: accountID, timerID: row.id, sourceFireAt: row.firesAt, title: row.title, delay: delay)
            do {
                try await scheduler.schedule(alert)
                guard current(request) else {
                    // All writes are serialized: this cannot remove a newer generation's add.
                    await scheduler.remove(ids: [identifier])
                    await scheduler.removeDelivered(ids: [identifier])
                    return
                }
                receipts[identifier] = row.firesAt
            } catch {
                if current(request) {
                    errorMessage = "Bob couldn’t schedule a timer alert. Check notification access and try again."
                }
            }
        }
    }

    private func clear(except accountID: String?) async {
        let pending = await scheduler.pending()
        let delivered = await scheduler.delivered()
        await scheduler.remove(ids: pending.filter { $0.accountID != accountID }.map(\.id))
        await scheduler.removeDelivered(ids: delivered.filter { $0.accountID != accountID }.map(\.id))
    }

    private func current(_ request: Int) -> Bool { request == generation && !Task.isCancelled }

    /// Serialize OS mutations, while allowing newer intents to invalidate slow network reads.
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = mutations
        let next = Task { @MainActor in
            await previous?.value
            await operation()
        }
        mutations = next
        await next.value
    }
}
