import Foundation
import XCTest
@testable import BobKit

final class ChatTranscriptTests: XCTestCase {
    private func streaming(_ partial: String = "") -> ChatTranscript {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: "Hi Bob")
        if !partial.isEmpty { transcript.apply(.textDelta(id: "t1", delta: partial)) }
        return transcript
    }

    private func reply(_ text: String, _ state: ChatMessageState, id: String = "b1") -> ChatMessage {
        ChatMessage(id: id, role: .bob, text: text, state: state)
    }

    private func person(_ text: String, id: String = "u1") -> ChatMessage {
        ChatMessage(id: id, role: .person, text: text, state: .complete)
    }

    func testInitialState() {
        let transcript = ChatTranscript()
        XCTAssertEqual(transcript.messages, [])
        XCTAssertNil(transcript.conversationID)
        XCTAssertNil(transcript.title)
        XCTAssertFalse(transcript.isStreaming)
        XCTAssertFalse(transcript.canStop)
    }

    func testInitialConversationID() {
        let transcript = ChatTranscript(conversationID: "c9")
        XCTAssertEqual(transcript.conversationID, "c9")
        XCTAssertEqual(transcript.messages, [])
        XCTAssertNil(transcript.title)
    }

    func testBeginTurnAppendsPersonAndStreamingReplyWithUntrimmedText() {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: "  Plan my week \n")
        XCTAssertEqual(transcript.messages, [person("  Plan my week \n"), reply("", .streaming)])
        XCTAssertTrue(transcript.isStreaming)
    }

    func testBeginTurnIgnoredWhileStreaming() {
        var transcript = streaming("Par")
        let before = transcript
        transcript.beginTurn(userMessageID: "u2", replyMessageID: "b2", text: "Again")
        XCTAssertEqual(transcript, before)
    }

    func testBeginTurnIgnoredForEmptyIDsAndWhitespaceText() {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "", replyMessageID: "b1", text: "Hi")
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "", text: "Hi")
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: " \n\t ")
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: "")
        XCTAssertEqual(transcript, ChatTranscript())
    }

    func testSecondTurnAfterCompletedReply() {
        var transcript = streaming("One")
        transcript.apply(.done)
        transcript.beginTurn(userMessageID: "u2", replyMessageID: "b2", text: "Two?")
        XCTAssertEqual(transcript.messages, [
            person("Hi Bob"), reply("One", .complete), person("Two?", id: "u2"), reply("", .streaming, id: "b2")
        ])
    }

    func testTextDeltasAppendInOrder() {
        var transcript = streaming()
        transcript.apply(.textDelta(id: "a", delta: "Hel"))
        transcript.apply(.textDelta(id: "b", delta: "lo"))
        XCTAssertEqual(transcript.messages.last, reply("Hello", .streaming))
    }

    func testEventsWithNothingToShowChangeNothing() {
        let events: [ChatStreamEvent] = [
            .textEnd(id: "t1"), .stepStart, .stepFinish, .toolOutputAvailable(toolCallID: "unknown"),
            .toolOutputError(toolCallID: "unknown"), .ignored(type: "mystery"), .malformed
        ]
        for event in events {
            var transcript = streaming("Par")
            let before = transcript
            transcript.apply(event)
            XCTAssertEqual(transcript, before, "\(event)")
        }
    }

    func testMessageStartRecordsIDAndTitleOnly() {
        var transcript = streaming("Par")
        transcript.apply(.messageStart(messageID: "m1", conversationID: "c1", title: "Week plan"))
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "Week plan")
        XCTAssertEqual(transcript.messages, [person("Hi Bob"), reply("Par", .streaming)])
    }

    func testRecordedValuesAreNeverReplaced() {
        var transcript = streaming()
        transcript.apply(.messageStart(messageID: "m1", conversationID: "c1", title: "First"))
        transcript.apply(.messageStart(messageID: "m2", conversationID: "c2", title: "Second"))
        transcript.apply(.finish(conversationID: "c3", title: "Third"))
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "First")
    }

    func testStartingConversationIDIsNeverReplaced() {
        var transcript = ChatTranscript(conversationID: "c0")
        transcript.apply(.messageStart(messageID: nil, conversationID: "c1", title: "T"))
        XCTAssertEqual(transcript.conversationID, "c0")
        XCTAssertEqual(transcript.title, "T")
    }

    func testEmptyAndNilValuesAreNeverRecorded() {
        var transcript = streaming()
        transcript.apply(.messageStart(messageID: nil, conversationID: "", title: ""))
        transcript.apply(.messageStart(messageID: nil, conversationID: nil, title: nil))
        XCTAssertNil(transcript.conversationID)
        XCTAssertNil(transcript.title)
        transcript.apply(.finish(conversationID: "c5", title: "Late"))
        XCTAssertEqual(transcript.conversationID, "c5")
        XCTAssertEqual(transcript.title, "Late")
    }

    func testFinishRecordsIDsAndCompletesReply() {
        var transcript = streaming("Done")
        transcript.apply(.finish(conversationID: "c1", title: "Title"))
        XCTAssertEqual(transcript.messages.last, reply("Done", .complete))
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "Title")
        XCTAssertFalse(transcript.isStreaming)
    }

    func testDoneCompletesStreamingReplyAndIsHarmlessAfterwards() {
        var transcript = streaming("Ok")
        transcript.apply(.done)
        XCTAssertEqual(transcript.messages.last, reply("Ok", .complete))
        let after = transcript
        transcript.apply(.done)
        XCTAssertEqual(transcript, after)
    }

    func testDeltaAfterCompletionIsIgnored() {
        var transcript = streaming("Ok")
        transcript.apply(.finish(conversationID: nil, title: nil))
        transcript.apply(.textDelta(id: "t1", delta: " more"))
        XCTAssertEqual(transcript.messages.last, reply("Ok", .complete))
    }

    func testMessageStartAndFinishWithNoReplyStreamingStillRecordIDs() {
        var transcript = ChatTranscript()
        transcript.apply(.messageStart(messageID: "m1", conversationID: "c1", title: nil))
        transcript.apply(.finish(conversationID: nil, title: "Named"))
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "Named")
        XCTAssertEqual(transcript.messages, [])
    }

    func testStopKeepsPartialTextAndGivesStopped() {
        var transcript = streaming("Half")
        transcript.stop()
        XCTAssertEqual(transcript.messages, [person("Hi Bob"), reply("Half", .stopped)])
        XCTAssertFalse(transcript.isStreaming)
    }

    func testStopAndFailWithNothingStreamingDoNothing() {
        var transcript = streaming("Ok")
        transcript.apply(.done)
        let completed = transcript
        transcript.stop()
        transcript.fail(.upstream)
        transcript.apply(.abort)
        transcript.apply(.error(.server))
        XCTAssertEqual(transcript, completed)
        var empty = ChatTranscript()
        empty.stop()
        empty.fail(.offline)
        XCTAssertEqual(empty, ChatTranscript())
    }

    func testAbortBehavesAsStop() {
        var transcript = streaming("Half")
        transcript.apply(.abort)
        XCTAssertEqual(transcript.messages.last, reply("Half", .stopped))
    }

    func testFailKeepsPartialTextWithExactError() {
        var transcript = streaming("Part")
        transcript.fail(.rateLimited(retryAfterSeconds: 7))
        XCTAssertEqual(transcript.messages, [person("Hi Bob"), reply("Part", .failed(.rateLimited(retryAfterSeconds: 7)))])
    }

    func testErrorEventBehavesAsFail() {
        var transcript = streaming("Part")
        transcript.apply(.error(.outOfCredit))
        XCTAssertEqual(transcript.messages.last, reply("Part", .failed(.outOfCredit)))
    }

    func testCanSend() {
        XCTAssertTrue(ChatTranscript().canSend(draft: " Hi "))
        XCTAssertFalse(ChatTranscript().canSend(draft: ""))
        XCTAssertFalse(ChatTranscript().canSend(draft: " \n\t"))
        XCTAssertFalse(streaming().canSend(draft: "Hi"))
        var failed = streaming()
        failed.fail(.upstream)
        XCTAssertTrue(failed.canSend(draft: "Hi"))
        var stopped = streaming()
        stopped.stop()
        XCTAssertTrue(stopped.canSend(draft: "Hi"))
    }

    func testCanStopEqualsIsStreaming() {
        var transcript = ChatTranscript()
        XCTAssertEqual(transcript.canStop, transcript.isStreaming)
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: "Hi")
        XCTAssertTrue(transcript.canStop)
        XCTAssertEqual(transcript.canStop, transcript.isStreaming)
        transcript.apply(.done)
        XCTAssertFalse(transcript.canStop)
    }

    func testFailureMessageForErrors() {
        let cases: [(ApiError, String?)] = [
            (.upstream, "Bob had trouble. Try again."), (.outOfCredit, "Bob is out of credit right now."),
            (.unauthenticated, "Please sign in again."), (.cancelled, nil)
        ]
        for (error, expected) in cases {
            var transcript = streaming("x")
            transcript.fail(error)
            XCTAssertEqual(transcript.failureMessage, expected, "\(error)")
        }
    }

    func testFailureMessageNilWhenLastIsNotFailedOrEmpty() {
        XCTAssertNil(ChatTranscript().failureMessage)
        var transcript = streaming("x")
        transcript.fail(.upstream)
        transcript.beginTurn(userMessageID: "u2", replyMessageID: "b2", text: "Retry")
        XCTAssertNil(transcript.failureMessage)
        transcript.apply(.done)
        XCTAssertNil(transcript.failureMessage)
    }

    func testFullRun() {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "b1", text: "What's on today?")
        transcript.apply(.messageStart(messageID: "m1", conversationID: "c42", title: "Today"))
        for delta in ["You have ", "two ", "meetings."] { transcript.apply(.textDelta(id: "t1", delta: delta)) }
        transcript.apply(.finish(conversationID: "c42", title: "Today"))
        transcript.apply(.done)
        XCTAssertEqual(transcript.messages, [person("What's on today?"), reply("You have two meetings.", .complete)])
        XCTAssertEqual(transcript.conversationID, "c42")
        XCTAssertEqual(transcript.title, "Today")
        XCTAssertFalse(transcript.isStreaming)
    }
}
