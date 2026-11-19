import Foundation

/// The push carries identifiers only. Authenticated destination clients still
/// decide whether the current account may read the resource.
public struct BobPushNotification: Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case notification, timer }
    public let accountID: String
    public let kind: Kind
    public let resourceID: String
    public let spaceID: String?
    public let target: NotificationTarget?
    public let id: String

    public func belongs(to accountID: String) -> Bool {
        UUID(uuidString: accountID)?.uuidString.lowercased() == self.accountID
    }

    public static func decode(_ data: Data) -> BobPushNotification? {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data), wire.version == 1,
              let account = canonical(wire.accountID) else { return nil }
        if wire.kind == .timer {
            guard let timer = canonical(wire.timerID) else { return nil }
            return BobPushNotification(accountID: account, kind: .timer, resourceID: timer,
                                       spaceID: nil, target: .calendar, id: account + ":timer:" + timer)
        }
        guard let notification = canonical(wire.notificationID), let resource = canonical(wire.resourceID),
              let type = wire.resourceType, !type.isEmpty, type.count <= 80,
              wire.spaceID == nil || canonical(wire.spaceID) != nil else { return nil }
        let space = canonical(wire.spaceID)
        let target: NotificationTarget?
        switch type {
        case "task": target = .task(resource)
        case "note": target = .note(resource)
        case "device": target = .device(resource)
        case "thread": target = space.map { .thread(id: resource, spaceID: $0) }
        case "reminder": target = .reminders
        case "event": target = .calendar
        case "space", "space_member", "space_invitation": target = space.map { .members(spaceID: $0) }
        default: target = nil
        }
        return BobPushNotification(accountID: account, kind: .notification, resourceID: resource,
                                   spaceID: space, target: target, id: account + ":notification:" + notification)
    }

    private static func canonical(_ value: String?) -> String? {
        value.flatMap { UUID(uuidString: $0)?.uuidString.lowercased() }
    }

    private struct Wire: Decodable {
        let version: Int
        let accountID: String
        let kind: Kind
        let timerID: String?
        let notificationID: String?
        let resourceType: String?
        let resourceID: String?
        let spaceID: String?
        enum CodingKeys: String, CodingKey {
            case version, kind
            case accountID = "account_id", timerID = "timer_id", notificationID = "notification_id"
            case resourceType = "resource_type", resourceID = "resource_id", spaceID = "space_id"
        }
    }
}

public enum PushLocalTimerCoverage {
    /// Keep successful local delivery receipts through Core's fifteen-minute
    /// push expiry, so reopening after a local ring cannot cause a second ring.
    public static func identifiers(pending: [TimerAlert], retained: [TimerAlert], accountID: String, now: Date) -> [String] {
        let eligible = pending + retained.filter { $0.sourceFireAt.addingTimeInterval(15 * 60) >= now }
        var result: [String] = []
        for alert in eligible where alert.accountID == accountID && UUID(uuidString: alert.timerID) != nil {
            if !result.contains(alert.timerID) { result.append(alert.timerID) }
            if result.count == 60 { break }
        }
        return result
    }
}
