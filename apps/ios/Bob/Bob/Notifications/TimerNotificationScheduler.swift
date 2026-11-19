import BobKit
import Foundation
import UserNotifications

/// OS delivery is independent of the app's lifetime once a request has been added.
@MainActor
final class TimerNotificationScheduler: TimerAlertScheduling {
    let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private let receiptKey = "bob.timer-alert-receipts.v1"

    init(center: UNUserNotificationCenter = .current(), defaults: UserDefaults = .standard) {
        self.center = center
        self.defaults = defaults
    }

    func pending() async -> [TimerAlert] {
        await center.pendingNotificationRequests().compactMap(Self.alert)
    }

    func localTimerIDs(accountID: String, now: Date = .now) async -> [String] {
        let pending = await pending()
        let delivered = await center.deliveredNotifications().compactMap { Self.alert($0.request) }
        return PushLocalTimerCoverage.identifiers(pending: pending, retained: readReceipts().map(\.alert) + delivered,
                                                  accountID: accountID, now: now)
    }

    func delivered() async -> [TimerAlert] {
        let delivered = await center.deliveredNotifications().compactMap { Self.alert($0.request) }
        let receipts = readReceipts().filter { $0.localFireAt <= Date() }.map(\.alert)
        return Array(Dictionary((receipts + delivered).map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer }).values)
    }

    func schedule(_ alert: TimerAlert) async throws {
        try await center.add(Self.request(for: alert))
        let receipt = Receipt(alert: alert, localFireAt: Date().addingTimeInterval(max(1, alert.delay)))
        writeReceipts(readReceipts().filter { $0.id != alert.id } + [receipt])
    }

    nonisolated static func request(for alert: TimerAlert) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = "Time's up. Bob is here when you're ready."
        content.sound = .default
        content.threadIdentifier = "bob.timers"
        content.userInfo = [
            "bobType": "timer", "accountID": alert.accountID, "timerID": alert.timerID,
            "sourceFireAt": alert.sourceFireAt.timeIntervalSince1970
        ]
        return UNNotificationRequest(identifier: alert.id, content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, alert.delay), repeats: false))
    }

    func remove(ids: [String]) async {
        center.removePendingNotificationRequests(withIdentifiers: ids)
        // Keep a due receipt if the person has dismissed its banner; a refresh must not ring twice.
        writeReceipts(readReceipts().filter { !ids.contains($0.id) || $0.localFireAt <= Date() })
    }

    func removeDelivered(ids: [String]) async {
        center.removeDeliveredNotifications(withIdentifiers: ids)
        writeReceipts(readReceipts().filter { !ids.contains($0.id) })
    }

    nonisolated static func alert(_ request: UNNotificationRequest) -> TimerAlert? {
        let data = request.content.userInfo
        guard data["bobType"] as? String == "timer",
              let accountID = data["accountID"] as? String, !accountID.isEmpty,
              let timerID = data["timerID"] as? String, !timerID.isEmpty,
              let timestamp = data["sourceFireAt"] as? Double, timestamp.isFinite,
              request.identifier == TimerAlert.identifier(accountID: accountID, timerID: timerID) else { return nil }
        return TimerAlert(id: request.identifier, accountID: accountID, timerID: timerID,
            sourceFireAt: Date(timeIntervalSince1970: timestamp), title: request.content.title,
            delay: (request.trigger as? UNTimeIntervalNotificationTrigger)?.timeInterval ?? 0)
    }

    private func readReceipts() -> [Receipt] {
        guard let data = defaults.data(forKey: receiptKey),
              let receipts = try? JSONDecoder().decode([Receipt].self, from: data) else { return [] }
        return receipts
    }

    private func writeReceipts(_ receipts: [Receipt]) {
        // Core caps active timers at 10; retain a bounded history solely for duplicate suppression.
        guard let data = try? JSONEncoder().encode(Array(receipts.suffix(128))) else { return }
        defaults.set(data, forKey: receiptKey)
    }

    private struct Receipt: Codable {
        let id: String
        let accountID: String
        let timerID: String
        let sourceFireAt: Date
        let localFireAt: Date

        init(alert: TimerAlert, localFireAt: Date) {
            id = alert.id; accountID = alert.accountID; timerID = alert.timerID
            sourceFireAt = alert.sourceFireAt; self.localFireAt = localFireAt
        }

        var alert: TimerAlert {
            TimerAlert(id: id, accountID: accountID, timerID: timerID, sourceFireAt: sourceFireAt, title: "Timer", delay: 0)
        }
    }
}
