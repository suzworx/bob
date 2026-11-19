import XCTest
@testable import BobKit

final class ChatReplyPartsTests: XCTestCase {
    private func streaming() -> ChatTranscript {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "u", replyMessageID: "b", text: "Hi")
        return transcript
    }

    func testAStreamBuildsPartsInOrder() {
        var transcript = streaming()
        transcript.apply(.reasoningStart(id: "r"))
        transcript.apply(.reasoningDelta(id: "r", delta: "hmm"))
        XCTAssertEqual(transcript.messages.last?.parts, [.reasoning("hmm", isStreaming: true)])
        transcript.apply(.reasoningEnd(id: "r"))
        transcript.apply(.toolInputStart(toolCallID: "a", toolName: "create_task"))
        transcript.apply(.toolInputAvailable(toolCallID: "a", toolName: "create_task"))
        transcript.apply(.toolInputStart(toolCallID: "b", toolName: "search"))
        transcript.apply(.toolOutputAvailable(toolCallID: "a"))
        transcript.apply(.toolOutputError(toolCallID: "b"))
        transcript.apply(.textStart(id: "t"))
        transcript.apply(.textDelta(id: "t", delta: "One"))
        transcript.apply(.textEnd(id: "t"))
        transcript.apply(.textStart(id: "t2"))
        transcript.apply(.textDelta(id: "t2", delta: "Two"))
        transcript.apply(.finish(conversationID: nil, title: nil))
        let reply = try! XCTUnwrap(transcript.messages.last)
        XCTAssertEqual(reply.parts, [
            .reasoning("hmm", isStreaming: false),
            .tools([ChatToolActivity(id: "a", toolName: "create_task", status: .done), ChatToolActivity(id: "b", toolName: "search", status: .failed)]),
            .text("One"),
            .text("Two")
        ])
        // The same words the server stores, so Copy and the read-back agree.
        XCTAssertEqual(reply.text, "One\n\nTwo")
    }

    func testStoppingEndsThinkingAndDropsAnEmptyPassage() {
        var transcript = streaming()
        transcript.apply(.reasoningStart(id: "r"))
        transcript.apply(.reasoningDelta(id: "r", delta: "hmm"))
        transcript.stop()
        XCTAssertEqual(transcript.messages.last?.parts, [.reasoning("hmm", isStreaming: false)])
        XCTAssertEqual(transcript.messages.last?.state, .stopped)

        var empty = streaming()
        empty.apply(.textDelta(id: "t", delta: "One"))
        empty.apply(.textStart(id: "t2"))
        empty.apply(.done)
        XCTAssertEqual(empty.messages.last?.parts, [.text("One")])
    }

    func testToolLabelsNeverShowARawName() {
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "create_task", status: .running).label, "Adding a task")
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "create_task", status: .done).label, "Added a task")
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "secret_tool", status: .running).label, "Working on it")
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "secret_tool", status: .done).label, "Done")
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "search", status: .failed).label, "Couldn't finish that")
        XCTAssertEqual(ChatToolActivity(id: "a", toolName: "search", status: .denied).label, "Not allowed")
    }

    func testThoughtLabels() {
        XCTAssertEqual(ChatReplyPart.thoughtLabel(isStreaming: true, seconds: nil), "Thinking...")
        XCTAssertEqual(ChatReplyPart.thoughtLabel(isStreaming: false, seconds: nil), "Thought for a few seconds")
        XCTAssertEqual(ChatReplyPart.thoughtLabel(isStreaming: false, seconds: 1), "Thought for a few seconds")
        XCTAssertEqual(ChatReplyPart.thoughtLabel(isStreaming: false, seconds: 12), "Thought for 12 seconds")
    }

    func testTimesAndTraceComeFromTheStream() {
        var transcript = ChatTranscript()
        let sent = Date(timeIntervalSince1970: 100)
        let server = Date(timeIntervalSince1970: 101)
        let trace = String(repeating: "ab", count: 16)
        transcript.beginTurn(userMessageID: "u", replyMessageID: "b", text: "Hi", at: sent)
        XCTAssertEqual(transcript.messages.map(\.createdAt), [sent, sent])
        transcript.apply(.messageStart(messageID: nil, conversationID: nil, title: nil, createdAt: server, traceID: trace))
        XCTAssertEqual(transcript.messages.last?.createdAt, server)
        XCTAssertEqual(transcript.messages.last?.traceID, trace)
    }

    private func detail(reply: String) -> ConversationDetail {
        func message(_ id: String, _ role: ConversationMessage.Role, _ text: String, _ position: Int) -> ConversationMessage {
            ConversationMessage(id: id, role: role, position: position, createdAt: Date(timeIntervalSince1970: 500), versions: [ConversationMessageVersion(id: "\(id)-v", parts: [.text(text)])])
        }
        return ConversationDetail(id: "c", title: "t", createdAt: Date(), updatedAt: Date(), messages: [message("su", .user, "Hi", 0), message("sb", .assistant, reply, 1)])
    }

    func testAReadBackKeepsTheStreamedTraceAndRating() {
        var transcript = streaming()
        let trace = String(repeating: "ab", count: 16)
        transcript.apply(.messageStart(messageID: nil, conversationID: "c", title: nil, traceID: trace))
        transcript.apply(.textDelta(id: "t", delta: "Same"))
        transcript.apply(.finish(conversationID: "c", title: nil))
        transcript.setFeedback(messageID: "b", positive: true)
        transcript.restore(detail(reply: "Same"))
        let reply = transcript.messages[1]
        XCTAssertEqual(reply.id, "sb")
        XCTAssertEqual(reply.traceID, trace)
        XCTAssertEqual(reply.feedback, true)
        XCTAssertEqual(reply.createdAt, Date(timeIntervalSince1970: 500))
    }

    func testADifferentReplyDoesNotInheritTheTrace() {
        var transcript = streaming()
        transcript.apply(.messageStart(messageID: nil, conversationID: "c", title: nil, traceID: String(repeating: "ab", count: 16)))
        transcript.apply(.textDelta(id: "t", delta: "Old"))
        transcript.apply(.finish(conversationID: "c", title: nil))
        transcript.restore(detail(reply: "New"))
        XCTAssertNil(transcript.messages[1].traceID)
    }

    func testFeedbackNeedsATrace() {
        var transcript = streaming()
        transcript.setFeedback(messageID: "b", positive: true)
        XCTAssertNil(transcript.messages.last?.feedback)
    }

    func testAttachmentSizeAndBytes() {
        let attachment = ChatAttachment(name: "a.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,AAECAw==")
        XCTAssertEqual(attachment.byteCount, 4)
        XCTAssertEqual(attachment.decodedData(), Data([0, 1, 2, 3]))
        XCTAssertFalse(attachment.isImage)
        XCTAssertEqual(attachment.displayName, "a.pdf")
        XCTAssertTrue(attachment.summary.hasPrefix("a.pdf, "))
    }

    func testAnAttachmentNeverKeepsARemoteAddress() {
        let attachment = ChatAttachment(name: nil, mediaType: "image/png", url: "https://tracker.example/x.png")
        XCTAssertNil(attachment.decodedData())
        XCTAssertNil(attachment.byteCount)
        XCTAssertEqual(attachment.displayName, "Image")
        XCTAssertEqual(attachment.summary, "Image")
    }

    func testMessageTimeIsShortTodayAndDatedOtherwise() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let today = ChatTimeFormat.text(now.addingTimeInterval(-60), now: now, calendar: calendar, locale: locale)
        XCTAssertTrue(today.contains("10:12"), today)
        XCTAssertFalse(today.contains("Nov"), today)
        let older = ChatTimeFormat.text(now.addingTimeInterval(-86_400 * 2), now: now, calendar: calendar, locale: locale)
        XCTAssertTrue(older.contains("Nov"), older)
    }
}
