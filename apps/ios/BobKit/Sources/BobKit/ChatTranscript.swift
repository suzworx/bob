import Foundation

public enum ChatRole: Equatable, Sendable {
    case person
    case bob
}

public enum ChatMessageState: Equatable, Sendable {
    case complete
    case streaming
    case stopped
    case failed(ApiError)
}

public struct ChatMessage: Equatable, Sendable, Identifiable {
    public let id: String
    public let role: ChatRole
    public internal(set) var text: String
    public internal(set) var state: ChatMessageState
    // Where it was spoken, when it was not typed here: "spoken", "via your device". Nil for typed text.
    public let originNote: String?
    // The files sent with the message.
    public let attachments: [ChatAttachment]
    // Read back from the server, so its id can anchor an edit. A reply streamed just now has another id on the server.
    public let isStored: Bool
    // The reply in order: its words, its thinking and what its tools did.
    public internal(set) var parts: [ChatReplyPart]
    public internal(set) var createdAt: Date?
    // What feedback on this reply attaches to. The server sends it only with the live stream, so a reply from history has none.
    public internal(set) var traceID: String?
    // The person's thumbs on this reply, this session. Never read back from the server.
    public internal(set) var feedback: Bool?
    // In a shared chat, who said it. Nil in a private one.
    public let author: ChatAuthor?
    public let isEdited: Bool
    public let isDeleted: Bool

    // Which side it hangs on: the person's own side unless someone else wrote it.
    public var isMine: Bool {
        role == .person && author?.isMe != false
    }

    public init(id: String, role: ChatRole, text: String, state: ChatMessageState, originNote: String? = nil, attachments: [ChatAttachment] = [], isStored: Bool = false, parts: [ChatReplyPart]? = nil, createdAt: Date? = nil, traceID: String? = nil, feedback: Bool? = nil, author: ChatAuthor? = nil, isEdited: Bool = false, isDeleted: Bool = false) {
        self.id = id
        self.role = role
        self.text = text
        self.state = state
        self.originNote = originNote
        self.attachments = attachments
        self.isStored = isStored
        self.parts = parts ?? (text.isEmpty ? [] : [.text(text)])
        self.createdAt = createdAt
        self.traceID = traceID
        self.feedback = feedback
        self.author = author
        self.isEdited = isEdited
        self.isDeleted = isDeleted
    }
}

// Who wrote a message in a shared chat. A private chat has only the person and Bob, so it has none.
public struct ChatAuthor: Equatable, Sendable {
    public let id: String
    public let name: String
    public let initials: String
    public let fillIndex: Int
    public let isMe: Bool

    public init(id: String, name: String, initials: String, fillIndex: Int = 0, isMe: Bool) {
        self.id = id
        self.name = name
        self.initials = initials
        self.fillIndex = fillIndex
        self.isMe = isMe
    }
}

// What the Chat screen shows, driven by the person's turns and the reply's stream events. Pure: the caller passes ids in.
public struct ChatTranscript: Equatable, Sendable {
    public private(set) var messages: [ChatMessage]
    public private(set) var conversationID: String?
    public private(set) var title: String?

    public init(conversationID: String? = nil) {
        self.messages = []
        self.conversationID = conversationID
        self.title = nil
    }

    public init(detail: ConversationDetail) {
        self.init(conversationID: detail.id)
        restore(detail)
    }

    // Shows what the server holds. The caller checks first that no turn is running.
    public mutating func restore(_ detail: ConversationDetail) {
        conversationID = detail.id
        title = detail.title.isEmpty ? nil : detail.title
        let shown = messages.filter { $0.role == .bob }
        var replyIndex = 0
        messages = detail.messages.map { stored in
            var message = ChatMessage(
                id: stored.id,
                role: stored.role == .user ? .person : .bob,
                text: stored.text,
                state: .complete,
                originNote: stored.originNote,
                attachments: stored.attachments,
                isStored: true,
                parts: stored.role == .user ? nil : ChatReplyPart.parts(from: stored.parts),
                createdAt: stored.createdAt
            )
            // The stored copy has no trace id, so a reply just streamed keeps its own, and its thumbs, while it is still the same reply.
            if stored.role == .assistant {
                if replyIndex < shown.count, shown[replyIndex].traceID != nil, shown[replyIndex].text == stored.text {
                    message.traceID = shown[replyIndex].traceID
                    message.feedback = shown[replyIndex].feedback
                }
                replyIndex += 1
            }
            return message
        }
    }

    // A shared chat: what the thread holds, as the caller mapped it. Nothing streams, so there's nothing to merge.
    public mutating func setRoom(id: String, title newTitle: String?, messages newMessages: [ChatMessage]) {
        conversationID = id
        title = newTitle
        messages = newMessages
    }

    public mutating func setFeedback(messageID: String, positive: Bool) {
        guard let index = messages.firstIndex(where: { $0.id == messageID }), messages[index].traceID != nil else {
            return
        }
        messages[index].feedback = positive
    }

    // The person renamed the chat, which beats whatever title it had.
    public mutating func setTitle(_ newTitle: String) {
        title = newTitle
    }

    // A reopened chat can end on a message Bob never answered: his turn failed or is still running.
    public var isUnanswered: Bool {
        messages.last?.role == .person
    }

    // The replies the server should now hold: it stores none for a reply that never produced anything.
    public var storableReplyCount: Int {
        messages.filter { $0.role == .bob && ($0.isStored || !$0.text.isEmpty) }.count
    }

    public var lastReplyID: String? {
        messages.last { $0.role == .bob }?.id
    }

    public var lastPersonMessage: ChatMessage? {
        messages.last { $0.role == .person }
    }

    // How to resend this person message, or nil until the message before it is known to the server.
    public func editTurn(for messageID: String) -> ChatTurn? {
        guard conversationID != nil, !isStreaming,
              let index = messages.firstIndex(where: { $0.id == messageID }), messages[index].role == .person else {
            return nil
        }
        guard index > 0 else {
            return .editFromStart
        }
        return messages[index - 1].isStored ? .edit(after: messages[index - 1].id) : nil
    }

    // This message and everything after it go.
    public mutating func removeFrom(messageID: String) {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else {
            return
        }
        messages.removeSubrange(index...)
    }

    // Replaces Bob's trailing reply with a new one streaming, under the same person message.
    public mutating func beginRegenerate(replyMessageID: String) {
        guard !isStreaming, !replyMessageID.isEmpty, let last = messages.lastIndex(where: { $0.role == .person }) else {
            return
        }
        messages.removeSubrange((last + 1)...)
        messages.append(ChatMessage(id: replyMessageID, role: .bob, text: "", state: .streaming))
    }

    public var isStreaming: Bool {
        guard let last = messages.last else {
            return false
        }
        return last.role == .bob && last.state == .streaming
    }

    public var canStop: Bool {
        isStreaming
    }

    public func canSend(draft: String, hasAttachments: Bool = false) -> Bool {
        !isStreaming && (Self.hasContent(draft) || hasAttachments)
    }

    public mutating func beginTurn(userMessageID: String, replyMessageID: String, text: String, at time: Date? = nil, origin: ChatOrigin = .text, attachments: [ChatAttachment] = []) {
        guard !isStreaming, !userMessageID.isEmpty, !replyMessageID.isEmpty, Self.hasContent(text) || !attachments.isEmpty else {
            return
        }
        messages.append(ChatMessage(id: userMessageID, role: .person, text: text, state: .complete, originNote: origin.note, attachments: attachments, createdAt: time))
        messages.append(ChatMessage(id: replyMessageID, role: .bob, text: "", state: .streaming, createdAt: time))
    }

    public mutating func apply(_ event: ChatStreamEvent) {
        switch event {
        case .messageStart(_, let conversationID, let title, let createdAt, let traceID):
            record(conversationID: conversationID, title: title)
            updateReply { reply in
                reply.createdAt = createdAt ?? reply.createdAt
                reply.traceID = traceID ?? reply.traceID
            }
        case .finish(let conversationID, let title, let traceID):
            record(conversationID: conversationID, title: title)
            updateReply { reply in
                reply.traceID = traceID ?? reply.traceID
                reply.state = .complete
            }
        case .textStart:
            // Each text part of a reply is its own passage, as it is stored.
            updateReply { $0.parts.startText() }
        case .textDelta(_, let delta):
            updateReply { reply in
                reply.parts.appendText(delta)
                reply.text = reply.parts.joinedText
            }
        case .reasoningStart:
            updateReply { $0.parts.startReasoning() }
        case .reasoningDelta(_, let delta):
            updateReply { $0.parts.appendReasoning(delta) }
        case .reasoningEnd:
            updateReply { $0.parts.endReasoning() }
        case .toolInputStart(let id, let name), .toolInputAvailable(let id, let name):
            updateReply { $0.parts.startTool(id: id, name: name) }
        case .toolInputError(let id, let name):
            updateReply { reply in
                reply.parts.startTool(id: id, name: name)
                reply.parts.setToolStatus(id: id, .failed)
            }
        case .toolOutputAvailable(let id):
            updateReply { $0.parts.setToolStatus(id: id, .done) }
        case .toolOutputError(let id):
            updateReply { $0.parts.setToolStatus(id: id, .failed) }
        case .toolOutputDenied(let id):
            updateReply { $0.parts.setToolStatus(id: id, .denied) }
        case .done:
            updateReply { $0.state = .complete }
        case .abort:
            stop()
        case .error(let apiError):
            fail(apiError)
        case .textEnd, .stepStart, .stepFinish, .ignored, .malformed:
            return
        }
    }

    public mutating func stop() {
        updateReply { $0.state = .stopped }
    }

    public mutating func fail(_ error: ApiError) {
        updateReply { $0.state = .failed(error) }
    }

    public var failureMessage: String? {
        guard let last = messages.last, last.role == .bob, case .failed(let error) = last.state else {
            return nil
        }
        let message = ApiErrorMapper.userMessage(error)
        return message.isEmpty ? nil : message
    }

    // Existing values are never replaced; an empty or missing value is never recorded.
    private mutating func record(conversationID newConversationID: String?, title newTitle: String?) {
        if conversationID == nil, let newConversationID, !newConversationID.isEmpty {
            conversationID = newConversationID
        }
        if title == nil, let newTitle, !newTitle.isEmpty {
            title = newTitle
        }
    }

    private mutating func updateReply(_ change: (inout ChatMessage) -> Void) {
        guard isStreaming, let index = messages.indices.last else {
            return
        }
        change(&messages[index])
        if messages[index].state != .streaming {
            messages[index].parts.endReasoning()
            messages[index].parts.dropEmptyText()
        }
    }

    private static func hasContent(_ text: String) -> Bool {
        text.contains { !$0.isWhitespace }
    }
}
