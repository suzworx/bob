import BobKit
import Foundation

protocol MemoryService: Sendable {
    func memories(_ query: MemoryQuery) async throws -> MemoryPage
    func create(content: String, kind: Memory.Kind) async throws -> Memory
    func correct(id: String, content: String) async throws -> Memory
    func forget(id: String) async throws
    func forgetAll() async throws
    func actionItems() async throws -> [ActionItem]
    func setStatus(actionItemID: String, status: ActionItem.Status) async throws -> ActionItem
    func promote(_ item: ActionItem) async throws
}

struct LiveMemoryService: MemoryService {
    let client: MemoryClient
    let space: PrivateSpace

    func memories(_ query: MemoryQuery) async throws -> MemoryPage { try await client.memories(query) }
    func create(content: String, kind: Memory.Kind) async throws -> Memory { try await client.create(content: content, kind: kind) }
    func correct(id: String, content: String) async throws -> Memory { try await client.correct(id: id, content: content) }
    func forget(id: String) async throws { try await client.forget(id: id) }
    func forgetAll() async throws { try await client.forgetAll() }
    func actionItems() async throws -> [ActionItem] { try await client.actionItems() }
    func setStatus(actionItemID: String, status: ActionItem.Status) async throws -> ActionItem {
        try await client.setStatus(actionItemID: actionItemID, status: status)
    }

    func promote(_ item: ActionItem) async throws {
        _ = try await client.promote(memoryID: item.memoryID, spaceID: try await space.id(), title: MemoryRules.taskTitle(item), dueAt: item.dueAt)
    }
}

// Made-up memories for previews and the demo build. Held in memory only, like the real ones.
actor StubMemoryService: MemoryService {
    nonisolated private static let pageSize = 8

    private var all: [Memory]
    private var items: [ActionItem]

    init(empty: Bool = false, now: Date = Date()) {
        guard !empty else {
            all = []
            items = []
            return
        }
        func memory(_ id: Int, _ kind: Memory.Kind, _ content: String, days: Double, confidence: Double = 0.9, sensitive: Bool = false, source: Memory.Source = Memory.Source(), supersededBy: String? = nil) -> Memory {
            let at = now.addingTimeInterval(-86400 * days)
            return Memory(id: "demo-m\(id)", kind: kind, content: content, confidence: confidence, sensitive: sensitive, source: source, supersededBy: supersededBy, createdAt: at, updatedAt: at)
        }
        all = [
            memory(1, .fact, "User's wife is Sam Example.", days: 1, source: Memory.Source(conversationID: "demo-c2")),
            memory(2, .preference, "User prefers tea in the morning.", days: 2),
            memory(3, .fact, "User is vegetarian.", days: 3, source: Memory.Source(conversationID: "demo-c1")),
            memory(4, .fact, "User's daughter plays the violin.", days: 4),
            memory(5, .preference, "User likes short answers.", days: 5, confidence: 0.5),
            memory(6, .fact, "User has a peanut allergy.", days: 6, sensitive: true),
            memory(7, .fact, "User lives near the river.", days: 7),
            memory(8, .preference, "User enjoys long walks.", days: 8),
            memory(9, .fact, "User works from home on Fridays.", days: 9),
            memory(10, .fact, "User lived in the old town.", days: 30, supersededBy: "demo-m7")
        ]
        items = [
            ActionItem(id: "demo-a1", memoryID: "demo-t1", content: "Call the school about the trip", dueAt: now.addingTimeInterval(86400)),
            ActionItem(id: "demo-a2", memoryID: "demo-t2", content: "Book the car service")
        ]
    }

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    func memories(_ query: MemoryQuery) async throws -> MemoryPage {
        try await pause()
        var found = all
        if let text = query.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            found = found.filter { $0.content.localizedCaseInsensitiveContains(text) }
        }
        let start = query.cursor.flatMap { cursor in found.firstIndex { $0.id == cursor } } ?? 0
        let end = min(start + Self.pageSize, found.count)
        return MemoryPage(memories: Array(found[start..<end]), nextCursor: end < found.count ? found[end].id : nil)
    }

    private func refuseSecrets(_ content: String) throws {
        let lower = content.lowercased()
        if lower.contains("password") || lower.contains(" pin") { throw ApiError.secretRefused }
    }

    func create(content: String, kind: Memory.Kind) async throws -> Memory {
        try await pause()
        try refuseSecrets(content)
        let memory = Memory(id: UUID().uuidString, kind: kind, content: content, createdAt: Date(), updatedAt: Date())
        all.insert(memory, at: 0)
        return memory
    }

    func correct(id: String, content: String) async throws -> Memory {
        try await pause()
        try refuseSecrets(content)
        guard let index = all.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        all[index].content = content
        return all[index]
    }

    func forget(id: String) async throws {
        try await pause()
        all.removeAll { $0.id == id }
    }

    func forgetAll() async throws {
        try await pause()
        all = []
        items = []
    }

    func actionItems() async throws -> [ActionItem] {
        try await pause()
        return items
    }

    func setStatus(actionItemID: String, status: ActionItem.Status) async throws -> ActionItem {
        guard let index = items.firstIndex(where: { $0.id == actionItemID }) else { throw ApiError.notFound }
        let old = items[index]
        items[index] = ActionItem(id: old.id, memoryID: old.memoryID, content: old.content, status: status, dueAt: old.dueAt)
        return items[index]
    }

    func promote(_ item: ActionItem) async throws {
        try await pause()
    }
}
