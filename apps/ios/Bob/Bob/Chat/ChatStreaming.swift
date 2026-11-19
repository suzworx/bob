import BobKit
import Foundation

// Streams Bob's reply to one person message and stops a running turn.
protocol ChatStreaming: Sendable {
    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?) -> AsyncThrowingStream<ChatStreamEvent, Error>
    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?, appBinding: ChatAppBinding?, attachments: [ChatOutgoingAttachment]) -> AsyncThrowingStream<ChatStreamEvent, Error>
    func stop(messageID: String) async
}

extension ChatStreaming {
    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?, appBinding: ChatAppBinding?, attachments: [ChatOutgoingAttachment]) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        guard appBinding == nil, attachments.isEmpty else { return AsyncThrowingStream { $0.finish(throwing: ApiError.invalidRequest) } }
        return send(text: text, messageID: messageID, conversationID: conversationID, turn: turn, origin: origin, workflowID: workflowID)
    }
}

// The real service: POST /api/chat through BobKit's ChatClient.
struct LiveChatService: ChatStreaming {
    let client: ChatClient

    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        client.send(text: text, messageID: messageID, conversationID: conversationID, origin: origin, turn: turn, workflowID: workflowID)
    }

    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?, appBinding: ChatAppBinding?, attachments: [ChatOutgoingAttachment]) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        client.send(text: text, messageID: messageID, conversationID: conversationID, origin: origin, turn: turn, workflowID: workflowID, appBinding: appBinding, attachments: attachments)
    }

    // A stop that fails leaves the turn stopped on screen; there is nothing more to do.
    func stop(messageID: String) async {
        _ = try? await client.stop(messageID: messageID)
    }
}

// A scripted Bob for previews and the demo build, with no network.
struct StubChatService: ChatStreaming {
    enum Mode: Sendable {
        case replying
        case failing(ApiError)
    }

    var mode: Mode = .replying
    var delay: Duration = .milliseconds(90)
    // Where the demo keeps its chats; previews leave it out.
    var conversations: StubConversationsService?

    private static let conversationID = "demo-1"
    private static let title = "Demo chat"
    private static let traceID = String(repeating: "d0", count: 16)
    private static let spokenReply = "Happy to help. I'm in demo mode, so this is a sample of how I sound. What else is on your mind?"
    private static let reply = """
    ## Happy to help

    I'm in **demo mode**, so this is a *sample* reply with `inline code` and a [link](https://example.com).

    - Lists work
      - and nest
    - as they do on the web

    > A quiet quote.

    ```swift
    let greeting = "A long line of code that scrolls sideways instead of breaking the layout of the page"
    ```

    | Day | Plan |
    |:----|-----:|
    | Mon | Walk |
    | Tue | Rest |
    """

    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        send(text: text, messageID: messageID, conversationID: conversationID, turn: turn, origin: origin, workflowID: workflowID, appBinding: nil, attachments: [])
    }

    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?, appBinding: ChatAppBinding?, attachments: [ChatOutgoingAttachment]) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        guard appBinding == nil else { return AsyncThrowingStream { $0.finish(throwing: ApiError.invalidRequest) } }
        let reply = origin == .voice ? Self.spokenReply : Self.reply
        let mode = mode
        let delay = delay
        let conversations = conversations
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let chat = await conversations?.beginTurn(conversationID: conversationID, messageID: messageID, text: text, turn: turn, origin: origin, attachments: attachments.map(\.display))
                    let chatID = chat?.id ?? Self.conversationID
                    let title = chat?.title ?? Self.title
                    continuation.yield(.messageStart(messageID: "reply-\(messageID)", conversationID: chatID, title: title, createdAt: Date(), traceID: Self.traceID))
                    switch mode {
                    case .replying:
                        continuation.yield(.reasoningStart(id: "r1"))
                        try await Task.sleep(for: delay)
                        continuation.yield(.reasoningDelta(id: "r1", delta: "They want a sample, so **show everything** a reply can hold."))
                        try await Task.sleep(for: delay * 5)
                        continuation.yield(.reasoningEnd(id: "r1"))
                        continuation.yield(.toolInputStart(toolCallID: "call-\(messageID)", toolName: "list_agenda"))
                        try await Task.sleep(for: delay * 5)
                        continuation.yield(.toolOutputAvailable(toolCallID: "call-\(messageID)"))
                        continuation.yield(.textStart(id: "text-1"))
                        // Cut anywhere, as a real stream is, so half-written markdown shows too.
                        var rest = Substring(reply)
                        while !rest.isEmpty {
                            try await Task.sleep(for: delay)
                            continuation.yield(.textDelta(id: "text-1", delta: String(rest.prefix(9))))
                            rest = rest.dropFirst(9)
                        }
                        await conversations?.finishTurn(conversationID: chatID, reply: reply)
                        continuation.yield(.finish(conversationID: chatID, title: title, traceID: Self.traceID))
                        continuation.yield(.done)
                        continuation.finish()
                    case .failing(let error):
                        try await Task.sleep(for: delay)
                        continuation.yield(.textDelta(id: "text-1", delta: "Happy"))
                        try await Task.sleep(for: delay)
                        continuation.finish(throwing: error)
                    }
                } catch {
                    // Only cancellation reaches here: the stream ends quietly.
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func stop(messageID: String) async {}
}
