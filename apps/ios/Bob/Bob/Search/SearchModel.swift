import BobKit
import Foundation
import Observation

// The search screen's results. Nothing here outlives the signed-in shell or reaches disk.
@MainActor @Observable final class SearchModel {
    var query = ""
    private(set) var searching = false
    private(set) var searched = false
    // Some part failed, so "nothing found" must not be claimed.
    private(set) var failed = false
    private(set) var chats: [ConversationSummary] = []
    private(set) var results: [SearchResult] = []
    private(set) var memories: [Memory] = []

    @ObservationIgnored private let service: SearchService
    @ObservationIgnored private var searchID = 0

    init(service: SearchService) {
        self.service = service
    }

    var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var hasNothing: Bool {
        chats.isEmpty && results.isEmpty && memories.isEmpty
    }

    func search() async {
        searchID += 1
        let id = searchID
        let text = trimmedQuery
        guard SearchRules.shouldSearch(text) else {
            clear()
            return
        }
        searching = true
        let service = service
        async let foundChats = Self.attempt { try await service.chats(text) }
        async let foundResults = Self.attempt { try await service.resources(text) }
        async let foundMemories = Self.attempt { try await service.memories(text) }
        let (chats, results, memories) = await (foundChats, foundResults, foundMemories)
        guard id == searchID, !Task.isCancelled else { return }
        self.chats = chats ?? []
        self.results = results ?? []
        self.memories = memories ?? []
        failed = chats == nil || results == nil || memories == nil
        searching = false
        searched = true
    }

    private func clear() {
        chats = []
        results = []
        memories = []
        failed = false
        searching = false
        searched = false
    }

    private nonisolated static func attempt<Value: Sendable>(_ work: @Sendable () async throws -> Value) async -> Value? {
        try? await work()
    }
}
