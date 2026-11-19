import Foundation

/// Metadata is persisted in the OS request so refreshing never restarts a countdown.
public struct TimerAlert: Equatable, Sendable, Identifiable {
    public let id: String
    public let accountID: String
    public let timerID: String
    public let sourceFireAt: Date
    public let title: String
    public let delay: TimeInterval

    public init(id: String, accountID: String, timerID: String, sourceFireAt: Date, title: String, delay: TimeInterval) {
        self.id = id
        self.accountID = accountID
        self.timerID = timerID
        self.sourceFireAt = sourceFireAt
        self.title = title
        self.delay = delay
    }

    public static func identifier(accountID: String, timerID: String) -> String {
        "bob.timer.\(accountID.utf8.count):\(accountID):\(timerID)"
    }
}

@MainActor public protocol TimerAlertScheduling: AnyObject {
    func pending() async -> [TimerAlert]
    /// Includes retained delivery receipts, even after a user dismisses the OS notification.
    func delivered() async -> [TimerAlert]
    func schedule(_ alert: TimerAlert) async throws
    func remove(ids: [String]) async
    func removeDelivered(ids: [String]) async
}
