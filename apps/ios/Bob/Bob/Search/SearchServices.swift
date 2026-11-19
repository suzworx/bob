import BobKit
import Foundation

// One search box over chats, what's in spaces, and memories. Each is asked separately, so one failing leaves the others' results.
protocol SearchService: Sendable {
    func chats(_ query: String) async throws -> [ConversationSummary]
    func resources(_ query: String) async throws -> [SearchResult]
    func memories(_ query: String) async throws -> [Memory]
}

struct LiveSearchService: SearchService {
    private static let limit = 20

    let client: SearchClient
    let conversations: ConversationsService
    let memory: MemoryClient

    func chats(_ query: String) async throws -> [ConversationSummary] {
        Array(try await conversations.list(query: query, archived: false).prefix(Self.limit))
    }

    func resources(_ query: String) async throws -> [SearchResult] {
        try await client.search(query, limit: Self.limit)
    }

    func memories(_ query: String) async throws -> [Memory] {
        do {
            return try await memory.memories(MemoryQuery(text: query, currentOnly: true, limit: Self.limit)).memories
        } catch ApiError.memoryUnavailable {
            return []
        }
    }
}

// Finds things in the demo data, so a result opens the real demo item.
struct StubSearchService: SearchService {
    private static let spaceID = "demo-space"

    let tasks: TasksService
    let notes: NotesService
    let memory: MemoryService
    let conversations: ConversationsService

    func chats(_ query: String) async throws -> [ConversationSummary] {
        try await conversations.list(query: query, archived: false)
    }

    func resources(_ query: String) async throws -> [SearchResult] {
        func matches(_ text: String?) -> Bool { text?.localizedCaseInsensitiveContains(query) ?? false }
        let foundTasks = try await tasks.tasks().filter { matches($0.title) || matches($0.body) }.map {
            SearchResult(kind: .task, resourceID: $0.id, spaceID: $0.spaceID, title: $0.title, snippet: $0.body ?? "", updatedAt: Date())
        }
        let foundNotes = try await notes.notes().filter { matches($0.title) || matches($0.body) }.map {
            SearchResult(kind: .note, resourceID: $0.id, spaceID: $0.spaceID, title: $0.title, snippet: $0.body, updatedAt: Date())
        }
        let others = [
            SearchResult(kind: .event, resourceID: "demo-e1", spaceID: Self.spaceID, title: "Dentist", updatedAt: Date()),
            SearchResult(kind: .thread, resourceID: "demo-th1", spaceID: demoFamily, title: "Family holiday plans", updatedAt: Date())
        ].filter { matches($0.title) }
        return foundTasks + foundNotes + others
    }

    func memories(_ query: String) async throws -> [Memory] {
        try await memory.memories(MemoryQuery(text: query)).memories
    }
}
