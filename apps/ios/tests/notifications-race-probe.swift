import BobKit
import Foundation

protocol NotificationsService: Sendable {
    func list(limit: Int, after: Int?, unreadOnly: Bool) async throws -> InboxPage
    func markRead(ids: [String]) async throws
    func markRead(upToCursor: Int) async throws
}
enum LoadPhase: Equatable { case loading, loaded, failed(ApiError) }
func apiError(_ error: Error) -> ApiError { error as? ApiError ?? .unknown(status: 0) }
func isCancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled }
enum AccessibilityAnnouncer { static func say(_ message: String) {} }

actor RaceService: NotificationsService {
    let item = InboxNotification(id: "notice", kind: .reminder, cursor: 1, createdAt: Date(timeIntervalSince1970: 0))
    var pending: CheckedContinuation<Void, Error>?
    var isRead = false
    func list(limit: Int, after: Int?, unreadOnly: Bool) async throws -> InboxPage {
        var current = item
        if isRead { current.readAt = Date(timeIntervalSince1970: 1) }
        return InboxPage(notifications: unreadOnly && isRead ? [] : [current], nextCursor: nil, unreadCount: isRead ? 0 : 1)
    }
    func markRead(ids: [String]) async throws {
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func markRead(upToCursor: Int) async throws {}
    func waitUntilPending() async { while pending == nil { await Task.yield() } }
    func succeed() { isRead = true; pending?.resume(); pending = nil }
    func fail() { pending?.resume(throwing: ApiError.offline); pending = nil }
}

@main struct Probe {
    @MainActor static func main() async {
        let service = RaceService()
        let model = NotificationsModel(service: service)
        await model.refresh()
        let item = model.items[0]
        let mutation = Task { await model.markRead(item) }
        await service.waitUntilPending()
        await model.setUnreadOnly(true)
        await service.fail()
        await mutation.value
        guard model.unread == 1, model.items.count == 1, model.items[0].isUnread else {
            print("FAIL: filter refresh followed by failed mark-read: unread=\(model.unread), expected 1")
            exit(1)
        }
        print("PASS: filter refresh followed by failed mark-read preserves authoritative unread=1")
        let success = Task { await model.markRead(item) }
        await service.waitUntilPending()
        await model.setUnreadOnly(false)
        await service.succeed()
        await success.value
        guard model.unread == 0, model.items.count == 1, !model.items[0].isUnread else {
            print("FAIL: successful mark-read did not reconcile replacement All snapshot")
            exit(1)
        }
        print("PASS: successful mark-read reconciles replacement All snapshot to read and count=0")
    }
}
