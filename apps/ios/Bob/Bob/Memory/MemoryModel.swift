import BobKit
import Foundation
import Observation
import SwiftUI

// What Bob remembers. Lives only in this object: it's never written to disk and leaves with the person's session.
@MainActor @Observable final class MemoryModel {
    enum Phase: Equatable {
        case loading, loaded, unavailable
        case failed(ApiError)
    }

    private(set) var phase: Phase = .loading
    private(set) var memories: [Memory] = []
    private(set) var nextCursor: String?
    private(set) var loadingMore = false
    private(set) var moreFailed = false
    private(set) var suggestions: [ActionItem] = []
    private(set) var suggestionsFailed = false
    var query = ""
    var tab: MemoryTab = .all
    var showsOlder = false
    var message: String?
    var undo: UndoOffer?

    let service: MemoryService
    private var loadID = 0
    private var writes = 0

    init(service: MemoryService) {
        self.service = service
    }

    var isSearching: Bool { !trimmedQuery.isEmpty }
    var groups: [ProductivityGroup<Memory>] { MemoryRules.groups(memories, tab: tab) }
    var older: [Memory] { tab == .all ? MemoryRules.older(memories) : [] }
    var hasNothing: Bool { MemoryRules.listed(memories).allSatisfy { $0.supersededBy != nil } }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    // A quiet refresh covers as many as the person had paged in, and a failure keeps the list on screen.
    func refresh(quiet: Bool = false) async {
        loadID += 1
        let id = loadID
        let text = trimmedQuery
        let covered = quiet ? memories.count : 0
        do {
            var page = try await service.memories(MemoryQuery(text: text))
            var loaded = page.memories
            while let cursor = page.nextCursor, loaded.count < covered, !page.memories.isEmpty {
                page = try await service.memories(MemoryQuery(text: text, cursor: cursor))
                loaded += page.memories
            }
            guard id == loadID, !Task.isCancelled else { return }
            memories = loaded
            nextCursor = page.nextCursor
            moreFailed = false
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch ApiError.memoryUnavailable {
            guard id == loadID else { return }
            phase = .unavailable
        } catch {
            guard id == loadID else { return }
            if quiet, phase == .loaded { return }
            phase = .failed(apiError(error))
        }
    }

    // Coming back to the app, unless a change is on its way: an answer from before it would undo it.
    func refreshOnReturn() async {
        guard writes == 0, !loadingMore else { return }
        await refresh(quiet: true)
        await refreshSuggestions()
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        moreFailed = false
        defer { loadingMore = false }
        do {
            let page = try await service.memories(MemoryQuery(text: trimmedQuery, cursor: cursor))
            memories += page.memories
            nextCursor = page.nextCursor
        } catch {
            moreFailed = !isCancelled(error)
        }
    }

    // Throw so the editor can keep the text and say why.
    func create(content: String, kind: Memory.Kind) async throws {
        writes += 1
        defer { writes -= 1 }
        _ = try await service.create(content: content, kind: kind)
        await refresh(quiet: true)
    }

    func correct(_ memory: Memory, content: String) async throws {
        writes += 1
        defer { writes -= 1 }
        let updated = try await service.correct(id: memory.id, content: MemoryVoice.forStorage(content))
        if let index = memories.firstIndex(where: { $0.id == memory.id }) { memories[index] = updated }
    }

    // The row goes at once and comes back to its place on failure.
    func forget(_ memory: Memory) async {
        writes += 1
        defer { writes -= 1 }
        guard let index = memories.firstIndex(where: { $0.id == memory.id }) else { return }
        memories.remove(at: index)
        do {
            try await service.forget(id: memory.id)
            AccessibilityAnnouncer.say("Memory deleted")
        } catch {
            memories.insert(memory, at: min(index, memories.count))
            message = "Couldn't delete the memory."
        }
    }

    func forgetAll() async {
        writes += 1
        defer { writes -= 1 }
        do {
            try await service.forgetAll()
            memories = []
            nextCursor = nil
            suggestions = []
            AccessibilityAnnouncer.say("All memories deleted")
        } catch {
            message = "Your memories couldn't be deleted."
        }
    }

    func refreshSuggestions() async {
        do {
            suggestions = try await service.actionItems().filter { $0.status == .open }
            suggestionsFailed = false
        } catch where isCancelled(error) {
            return
        } catch {
            suggestionsFailed = apiError(error) != .memoryUnavailable
        }
    }

    // Marks it done or dropped, with the way back offered.
    func close(_ item: ActionItem, status: ActionItem.Status) async {
        guard let index = suggestions.firstIndex(where: { $0.id == item.id }) else { return }
        suggestions.remove(at: index)
        do {
            _ = try await service.setStatus(actionItemID: item.id, status: status)
            undo = UndoOffer(message: status == .done ? "Done: \(item.content)" : "Dismissed \(item.content)") { [weak self] in
                guard let self else { return }
                do {
                    let reopened = try await self.service.setStatus(actionItemID: item.id, status: .open)
                    self.suggestions.insert(reopened, at: min(index, self.suggestions.count))
                } catch {
                    self.message = "That could not be undone."
                }
            }
        } catch {
            suggestions.insert(item, at: min(index, suggestions.count))
            message = "The suggestion could not be updated."
        }
    }

    // A copy goes to the person's private space, with its due date, and the suggestion closes so there's one row.
    func addAsTask(_ item: ActionItem) async {
        guard let index = suggestions.firstIndex(where: { $0.id == item.id }) else { return }
        do {
            try await service.promote(item)
            suggestions.remove(at: index)
            _ = try await service.setStatus(actionItemID: item.id, status: .done)
            AccessibilityAnnouncer.say("Added as a task")
        } catch {
            message = "It could not be added as a task."
            await refreshSuggestions()
        }
    }
}

enum AccessibilityAnnouncer {
    @MainActor static func say(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }
}
