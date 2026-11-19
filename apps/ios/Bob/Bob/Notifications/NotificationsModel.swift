import BobKit
import Foundation
import Observation

// The inbox. Lives only in this object and leaves with the person's session.
@MainActor @Observable final class NotificationsModel {
    nonisolated private static let pageSize = 25

    private(set) var phase: LoadPhase = .loading
    private(set) var items: [InboxNotification] = []
    private(set) var nextCursor: Int?
    private(set) var unread = 0
    private(set) var unreadOnly = false
    private(set) var loadingMore = false
    private(set) var moreFailed = false
    var message: String?

    let service: NotificationsService
    private var loadID = 0
    private var countID = 0
    private var pendingReads: Set<String> = []

    init(service: NotificationsService) {
        self.service = service
    }

    var hasUnread: Bool { unread > 0 || items.contains(where: \.isUnread) }

    // For the indicator on the tab: keeps the last known count on a failure.
    func refreshCount() async {
        countID += 1
        let id = countID
        if let page = try? await service.list(limit: 1, after: nil, unreadOnly: true), id == countID {
            unread = page.unreadCount
        }
    }

    func setUnreadOnly(_ value: Bool) async {
        guard value != unreadOnly else { return }
        unreadOnly = value
        await refresh()
    }

    func refresh(quiet: Bool = false) async {
        loadID += 1
        countID += 1
        let id = loadID
        loadingMore = false
        if !quiet { phase = .loading }
        do {
            let page = try await service.list(limit: Self.pageSize, after: nil, unreadOnly: unreadOnly)
            guard id == loadID else { return }
            items = page.notifications
            nextCursor = page.nextCursor
            unread = page.unreadCount
            moreFailed = false
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard id == loadID else { return }
            if quiet, phase == .loaded { return }
            phase = .failed(apiError(error))
        }
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        let id = loadID
        loadingMore = true
        moreFailed = false
        defer { if id == loadID { loadingMore = false } }
        do {
            let page = try await service.list(limit: Self.pageSize, after: cursor, unreadOnly: unreadOnly)
            guard id == loadID else { return }
            let seen = Set(items.map(\.id))
            items += page.notifications.filter { !seen.contains($0.id) }
            nextCursor = page.nextCursor
            unread = page.unreadCount
        } catch {
            guard id == loadID else { return }
            moreFailed = !isCancelled(error)
        }
    }

    // Reconcile with the server after mutation: a filter refresh may replace the list while it is saving.
    func markRead(_ item: InboxNotification, quietly: Bool = false) async {
        guard items.contains(where: { $0.id == item.id && $0.isUnread }),
              pendingReads.insert(item.id).inserted else { return }
        countID += 1
        defer { pendingReads.remove(item.id) }
        do {
            try await service.markRead(ids: [item.id])
            await refresh(quiet: true)
        } catch {
            if !quietly, !isCancelled(error) { message = "Couldn't mark that read. Try again." }
        }
    }

    // Items are newest first and the server marks everything at or below a cursor, so the top row covers them all.
    func markAllRead() async {
        guard let top = items.first else { return }
        countID += 1
        do {
            try await service.markRead(upToCursor: top.cursor)
            await refresh(quiet: true)
            AccessibilityAnnouncer.say("All marked read")
        } catch {
            if !isCancelled(error) { message = "Couldn't mark notifications read. Try again." }
        }
    }
}
