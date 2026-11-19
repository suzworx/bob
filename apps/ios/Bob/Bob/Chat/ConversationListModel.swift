import BobKit
import Foundation
import Observation

// The chat list: the person's chats, the archived ones, and every change to them. It re-reads after each change, as the web does.
@MainActor @Observable final class ConversationListModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var conversations: [ConversationSummary] = []
    private(set) var archived: [ConversationSummary] = []
    var query = ""
    var showsArchived = false
    var message: String?
    var undo: UndoOffer?

    @ObservationIgnored private let service: ConversationsService
    // Only the newest answer is shown, so a slow earlier search can't replace a later one.
    @ObservationIgnored private var loadID = 0

    init(service: ConversationsService) {
        self.service = service
    }

    var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func groups(now: Date) -> [ConversationGroup] {
        ConversationRules.groups(conversations, now: now)
    }

    func refresh() async {
        loadID += 1
        let id = loadID
        do {
            async let found = service.list(query: isSearching ? query : nil, archived: false)
            async let stored = service.list(query: nil, archived: true)
            let (rows, archivedRows) = try await (found, stored)
            guard id == loadID else { return }
            conversations = rows
            archived = archivedRows
            phase = .loaded
        } catch {
            guard id == loadID, !isCancelled(error) else { return }
            if phase != .loaded { phase = .failed(apiError(error)) }
        }
    }

    func setPinned(_ row: ConversationSummary, pinned: Bool) async {
        await run { try await self.service.setPinned(id: row.id, pinned: pinned) }
    }

    func archive(_ row: ConversationSummary) async {
        guard await run({ try await self.service.setArchived(id: row.id, archived: true) }) else { return }
        undo = UndoOffer(message: "Chat archived") { [weak self] in await self?.unarchive(row) }
    }

    func unarchive(_ row: ConversationSummary) async {
        await run { try await self.service.setArchived(id: row.id, archived: false) }
    }

    // Throws so the sheet can keep the words and say why.
    func rename(_ row: ConversationSummary, title: String) async throws {
        try await service.rename(id: row.id, title: title)
        await refresh()
    }

    func delete(_ row: ConversationSummary) async -> Bool {
        await run({ try await self.service.delete(id: row.id) }, failure: "Couldn't delete it. Try again.")
    }

    // The chat as text to share, or nil after saying why not.
    func markdown(_ row: ConversationSummary) async -> String? {
        do {
            return ConversationRules.markdown(try await service.conversation(id: row.id))
        } catch {
            if !isCancelled(error) { message = "Couldn't get that chat to share." }
            return nil
        }
    }

    @discardableResult private func run(_ change: @escaping () async throws -> Void, failure: String = "Couldn't update that chat.") async -> Bool {
        do {
            try await change()
            await refresh()
            return true
        } catch {
            if !isCancelled(error) { message = failure }
            return false
        }
    }
}
