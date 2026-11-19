import BobKit
import Foundation

// The person's past chats. The view models see this, never the network.
protocol ConversationsService: Sendable {
    func list(query: String?, archived: Bool) async throws -> [ConversationSummary]
    func conversation(id: String) async throws -> ConversationDetail
    func rename(id: String, title: String) async throws
    func setPinned(id: String, pinned: Bool) async throws
    func setArchived(id: String, archived: Bool) async throws
    func delete(id: String) async throws
    func deleteMessages(conversationID: String, from messageID: String) async throws
    func sendFeedback(traceID: String, positive: Bool) async throws
    func markHeard(conversationID: String, messageID: String, heardCharacters: Int) async throws
}

extension ConversationsClient: ConversationsService {}

// Made-up chats for previews and the demo build, held in memory only. Bob's scripted replies land here too, so a reopened chat shows them.
actor StubConversationsService: ConversationsService {
    private struct Entry {
        var summary: ConversationSummary
        var messages: [ConversationMessage]
    }

    private var entries: [Entry] = []

    init(empty: Bool = false, now: Date = Date()) {
        guard !empty else { return }
        func entry(_ id: String, _ title: String, days: Double, pinned: Bool = false, archived: Bool = false, _ lines: [(ConversationMessage.Role, String)], origin: String = "web_text") -> Entry {
            let at = now.addingTimeInterval(-86400 * days)
            let messages = lines.enumerated().map { index, line in
                Self.message(id: "\(id)-\(index)", role: line.0, text: line.1, position: index, origin: origin, at: at)
            }
            return Entry(summary: ConversationSummary(id: id, title: title, createdAt: at, updatedAt: at, pinned: pinned, archived: archived), messages: messages)
        }
        entries = [
            entry("demo-c1", "Dinner for Friday", days: 0, [(.user, "What should I cook on Friday?"), (.assistant, "How about a mushroom risotto? You have rice at home.")]),
            entry("demo-c2", "Birthday ideas for Sam", days: 3, pinned: true, [(.user, "Ideas for Sam's birthday?"), (.assistant, "A picnic by the river, or tickets to the violin concert.")]),
            entry("demo-c3", "Walk before work", days: 1, [(.user, "Remind me to walk before work."), (.assistant, "Done. I'll nudge you at 7.")], origin: "device"),
            entry("demo-c4", "Unanswered question", days: 5, [(.user, "Can you check the train times?")]),
            entry("demo-c5", "Old trip plans", days: 40, archived: true, [(.user, "Plan a weekend away."), (.assistant, "The coast is lovely in spring.")]),
            Self.richEntry(now: now)
        ]
    }

    // A past chat holding every kind of part a stored message can have.
    private nonisolated static func richEntry(now: Date) -> Entry {
        let at = now.addingTimeInterval(-86400 * 2)
        let image = ChatAttachment(name: "pixel.png", mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==")
        let file = ChatAttachment(name: "plan.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0xLjQK")
        let person = ConversationMessage(id: "demo-c6-0", role: .user, position: 0, createdAt: at, versions: [ConversationMessageVersion(id: "demo-c6-0-v", parts: [.file(image), .file(file), .text("What's in these?")])])
        let reply = ConversationMessage(id: "demo-c6-1", role: .assistant, position: 1, createdAt: at, versions: [ConversationMessageVersion(id: "demo-c6-1-v", parts: [
            .reasoning("Look at both files, then **summarise**."),
            .tool(ChatToolActivity(id: "a", toolName: "read_note", status: .done)),
            .tool(ChatToolActivity(id: "b", toolName: "search", status: .failed)),
            .text("### What I found\n\nA **tiny** image and a one-page plan. See [the docs](https://example.com).\n\n1. First\n2. Second\n\n| Very long column heading | Another very long column heading | A third very long column heading |\n|---|---|---|\n| a | b | c |")
        ])])
        return Entry(summary: ConversationSummary(id: "demo-c6", title: "Rich reply sample", createdAt: at, updatedAt: at), messages: [person, reply])
    }

    private nonisolated static func message(id: String, role: ConversationMessage.Role, text: String, position: Int, origin: String = "web_text", at: Date = Date(), files: [ChatAttachment] = []) -> ConversationMessage {
        ConversationMessage(id: id, role: role, position: position, origin: origin, createdAt: at, versions: [ConversationMessageVersion(id: "\(id)-v", parts: [.text(text)] + files.map(ConversationPart.file))])
    }

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    func list(query: String?, archived: Bool) async throws -> [ConversationSummary] {
        try await pause()
        let text = query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return entries.map(\.summary)
            .filter { $0.archived == archived && (text.isEmpty || $0.title.localizedCaseInsensitiveContains(text)) }
            .sorted { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
    }

    func conversation(id: String) async throws -> ConversationDetail {
        try await pause()
        guard let entry = entries.first(where: { $0.summary.id == id }) else { throw ApiError.notFound }
        return ConversationDetail(id: id, title: entry.summary.title, createdAt: entry.summary.createdAt, updatedAt: entry.summary.updatedAt, messages: entry.messages)
    }

    private func change(_ id: String, _ apply: (inout ConversationSummary) -> Void) throws {
        guard let index = entries.firstIndex(where: { $0.summary.id == id }) else { throw ApiError.notFound }
        apply(&entries[index].summary)
    }

    func rename(id: String, title: String) async throws {
        try await pause()
        try change(id) { $0.title = title }
    }

    func setPinned(id: String, pinned: Bool) async throws {
        try await pause()
        try change(id) { $0.pinned = pinned }
    }

    func setArchived(id: String, archived: Bool) async throws {
        try await pause()
        try change(id) { $0.archived = archived }
    }

    func delete(id: String) async throws {
        try await pause()
        entries.removeAll { $0.summary.id == id }
    }

    func deleteMessages(conversationID: String, from messageID: String) async throws {
        try await pause()
        guard let index = entries.firstIndex(where: { $0.summary.id == conversationID }),
              let cut = entries[index].messages.firstIndex(where: { $0.id == messageID }) else { return }
        entries[index].messages.removeSubrange(cut...)
    }

    func sendFeedback(traceID: String, positive: Bool) async throws {
        try await pause()
    }

    func markHeard(conversationID: String, messageID: String, heardCharacters: Int) async throws {}

    // What POST /api/chat does before the reply: finds or makes the chat and applies the turn.
    func beginTurn(conversationID: String?, messageID: String, text: String, turn: ChatTurn, origin: ChatOrigin = .text, attachments: [ChatAttachment] = []) -> (id: String, title: String) {
        let index: Int
        if let conversationID, let found = entries.firstIndex(where: { $0.summary.id == conversationID }) {
            index = found
        } else {
            let title = String(text.prefix(40))
            entries.insert(Entry(summary: ConversationSummary(id: "demo-\(UUID().uuidString)", title: title, createdAt: Date(), updatedAt: Date()), messages: []), at: 0)
            index = 0
        }
        switch turn {
        case .new: break
        case .regenerate:
            while entries[index].messages.last?.role == .assistant { entries[index].messages.removeLast() }
        case .edit(let after):
            if let cut = entries[index].messages.firstIndex(where: { $0.id == after }) {
                entries[index].messages.removeSubrange((cut + 1)...)
            }
        case .editFromStart:
            entries[index].messages = []
        }
        if turn != .regenerate {
            entries[index].messages.append(Self.message(id: messageID, role: .user, text: text, position: entries[index].messages.count, origin: origin.rawValue, files: attachments))
        }
        entries[index].summary.updatedAt = Date()
        return (entries[index].summary.id, entries[index].summary.title)
    }

    func finishTurn(conversationID: String, reply: String) {
        guard let index = entries.firstIndex(where: { $0.summary.id == conversationID }) else { return }
        entries[index].messages.append(Self.message(id: "reply-\(UUID().uuidString)", role: .assistant, text: reply, position: entries[index].messages.count))
    }
}
