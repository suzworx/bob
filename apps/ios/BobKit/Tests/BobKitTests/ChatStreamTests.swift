import XCTest
@testable import BobKit

final class ChatStreamTests: XCTestCase {
    private let reply = """
        data: {"type":"start","messageId":"msg-1"}

        data: {"type":"start-step"}

        data: {"type":"text-start","id":"t1"}

        data: {"type":"text-delta","id":"t1","delta":"Hel"}

        data: {"type":"text-delta","id":"t1","delta":"lo"}

        data: {"type":"text-end","id":"t1"}

        data: {"type":"finish-step"}

        data: {"type":"finish"}

        data: [DONE]


        """

    private let replyEvents: [ChatStreamEvent] = [
        .messageStart(messageID: "msg-1", conversationID: nil, title: nil),
        .stepStart,
        .textStart(id: "t1"),
        .textDelta(id: "t1", delta: "Hel"),
        .textDelta(id: "t1", delta: "lo"),
        .textEnd(id: "t1"),
        .stepFinish,
        .finish(conversationID: nil, title: nil),
        .done,
    ]

    private func feed(_ text: String) -> [ChatStreamEvent] {
        var parser = ChatStreamParser()
        return parser.feed(Data(text.utf8))
    }

    func testFullRealisticReply() {
        XCTAssertEqual(feed(reply), replyEvents)
    }

    func testAllAtOnceAndByteByByteGiveIdenticalEvents() {
        var parser = ChatStreamParser()
        var byteByByte: [ChatStreamEvent] = []
        for byte in Data(reply.utf8) {
            byteByByte += parser.feed(Data([byte]))
        }
        byteByByte += parser.finish()
        XCTAssertEqual(byteByByte, replyEvents)
        XCTAssertEqual(feed(reply), byteByByte)
    }

    func testMultiByteDeltaSplitAtEveryByteBoundaryArrivesIntact() {
        let bytes = Data("data: {\"type\":\"text-delta\",\"id\":\"t1\",\"delta\":\"h\u{E9}llo \u{1F642}\"}\n\n".utf8)
        let expected: [ChatStreamEvent] = [.textDelta(id: "t1", delta: "h\u{E9}llo \u{1F642}")]
        for split in 0...bytes.count {
            var parser = ChatStreamParser()
            let events = parser.feed(bytes.prefix(split)) + parser.feed(bytes.suffix(from: split))
            XCTAssertEqual(events, expected, "split at \(split)")
        }
    }

    func testCRLFLineEndings() {
        let text = "data: {\"type\":\"text-start\",\"id\":\"t1\"}\r\n\r\ndata: [DONE]\r\n\r\n"
        XCTAssertEqual(feed(text), [.textStart(id: "t1"), .done])
    }

    func testLoneCarriageReturnIsNotALineEnding() {
        XCTAssertEqual(feed("data: {\"type\":\"finish\"}\r\r"), [])
    }

    func testCommentAndFieldLinesAreIgnored() {
        let text = """
            : keep-alive
            event: message
            id: 7
            retry: 1000
            data: {"type":"abort"}


            """
        XCTAssertEqual(feed(text), [.abort])
    }

    func testDataValueWithoutLeadingSpace() {
        XCTAssertEqual(feed("data:{\"type\":\"finish\"}\n\ndata:[DONE]\n\n"), [.finish(conversationID: nil, title: nil), .done])
    }

    func testTwoDataLinesInOneBlockAreJoinedWithLineFeed() {
        let joined = "data: {\"type\":\"text-delta\",\ndata: \"id\":\"t1\",\"delta\":\"x\"}\n\n"
        XCTAssertEqual(feed(joined), [.textDelta(id: "t1", delta: "x")])
        // Joined without a separator this would read "n":12 and parse; with LF it is invalid JSON.
        XCTAssertEqual(feed("data: {\"type\":\"finish\",\"n\":1\ndata: 2}\n\n"), [.malformed])
        // "[DONE]" followed by an empty data line is "[DONE]\n", not the sentinel.
        XCTAssertEqual(feed("data: [DONE]\ndata:\n\n"), [.malformed])
    }

    func testDoneSentinel() {
        XCTAssertEqual(feed("data: [DONE]\n\n"), [.done])
    }

    func testUnknownDataTypesAreIgnoredWithTheirType() {
        let types = ["mystery-type", "data-weather", "tool-input-delta"]
        let text = types.map { "data: {\"type\":\"\($0)\",\"id\":\"r1\",\"delta\":\"x\"}\n\n" }.joined()
        XCTAssertEqual(feed(text), types.map { ChatStreamEvent.ignored(type: $0) })
    }

    func testMalformedPayloads() {
        let text = """
            data: {"type":"finish"

            data: ["type","finish"]

            data: {"id":"t1","delta":"x"}

            data: {"type":"text-delta","id":"t1"}

            data: {"type":7}

            data: {"type":"text-start"}


            """
        XCTAssertEqual(feed(text), Array(repeating: .malformed, count: 6))
    }

    func testToolEventsMapWithInputAndOutputDropped() {
        let text = """
            data: {"type":"tool-input-start","toolCallId":"call-1","toolName":"search"}

            data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"search","input":{"q":"x"}}

            data: {"type":"tool-output-available","toolCallId":"call-1","output":{"hits":[1,2]}}

            data: {"type":"tool-input-error","toolCallId":"call-2","toolName":"lookup","input":"bad","errorText":"nope"}

            data: {"type":"tool-output-error","toolCallId":"call-3","errorText":"failed"}

            data: {"type":"tool-input-start","toolCallId":"call-4"}


            """
        XCTAssertEqual(feed(text), [
            .toolInputStart(toolCallID: "call-1", toolName: "search"),
            .toolInputAvailable(toolCallID: "call-1", toolName: "search"),
            .toolOutputAvailable(toolCallID: "call-1"),
            .toolInputError(toolCallID: "call-2", toolName: "lookup"),
            .toolOutputError(toolCallID: "call-3"),
            .malformed,
        ])
    }

    func testErrorEventCarriesErrorText() {
        XCTAssertEqual(feed("data: {\"type\":\"error\",\"errorText\":\"Rate limited\"}\n\n"), [.error(.upstream)])
    }

    func testStartWithoutMessageID() {
        XCTAssertEqual(feed("data: {\"type\":\"start\"}\n\n"), [.messageStart(messageID: nil, conversationID: nil, title: nil)])
    }

    func testBlockWithOnlyCommentsProducesNoEvent() {
        XCTAssertEqual(feed(": ping\n: ping again\n\n\n\n"), [])
    }

    func testEmptyFeedReturnsEmptyArray() {
        XCTAssertEqual(feed(""), [])
    }

    func testFinishFlushesFinalEventWithoutTrailingBlankLine() {
        var parser = ChatStreamParser()
        XCTAssertEqual(parser.feed(Data("data: {\"type\":\"finish\"}\n\ndata: [DONE]".utf8)), [.finish(conversationID: nil, title: nil)])
        XCTAssertEqual(parser.finish(), [.done])
    }

    func testFinishOnEmptyBufferReturnsEmptyArray() {
        var parser = ChatStreamParser()
        XCTAssertEqual(parser.finish(), [])
        XCTAssertEqual(parser.feed(Data(": comment only".utf8)), [])
        XCTAssertEqual(parser.finish(), [])
    }

    func testFeedAfterFinishStartsFromAnEmptyBuffer() {
        var parser = ChatStreamParser()
        XCTAssertEqual(parser.feed(Data("data: {\"type\":\"abo".utf8)), [])
        XCTAssertEqual(parser.finish(), [.malformed])
        XCTAssertEqual(parser.feed(Data("data: {\"type\":\"abort\"}\n\n".utf8)), [.abort])
    }

    // MARK: Reviewer fixes (#1229)

    func testStartAndFinishCarryTheNewConversationIdAndTitle() {
        let start = #"data: {"type":"start","messageId":"m1","messageMetadata":{"workflowId":"w","createdAt":1,"conversationId":"cnv_1","title":"Trip plan"}}"#
        let finish = #"data: {"type":"finish","finishReason":"stop","messageMetadata":{"workflowId":"w","conversationId":"cnv_1","title":"Trip plan"}}"#
        XCTAssertEqual(feed(start + "\n\n" + finish + "\n\n"), [
            .messageStart(messageID: "m1", conversationID: "cnv_1", title: "Trip plan", createdAt: Date(timeIntervalSince1970: 0.001)),
            .finish(conversationID: "cnv_1", title: "Trip plan"),
        ])
    }

    func testMetadataWithoutAConversationLeavesTheFieldsNil() {
        let start = #"data: {"type":"start","messageId":"m1","messageMetadata":{"workflowId":"w","createdAt":1}}"#
        XCTAssertEqual(feed(start + "\n\n"), [.messageStart(messageID: "m1", conversationID: nil, title: nil, createdAt: Date(timeIntervalSince1970: 0.001))])
    }

    func testNonStringMetadataIsIgnored() {
        let finish = #"data: {"type":"finish","messageMetadata":{"conversationId":7,"title":["x"]}}"#
        XCTAssertEqual(feed(finish + "\n\n"), [.finish(conversationID: nil, title: nil)])
        let notAnObject = #"data: {"type":"start","messageMetadata":"oops"}"#
        XCTAssertEqual(feed(notAnObject + "\n\n"), [.messageStart(messageID: nil, conversationID: nil, title: nil)])
    }

    func testAStreamErrorOfOutOfCreditMapsToOutOfCredit() {
        XCTAssertEqual(feed(#"data: {"type":"error","errorText":"out_of_credit"}"# + "\n\n"), [.error(.outOfCredit)])
    }

    func testAnyOtherStreamErrorMapsToUpstreamAndNeverKeepsTheText() {
        for text in ["The assistant could not complete that request.", "", "Out_Of_Credit", "out_of_credit "] {
            let json = #"data: {"type":"error","errorText":"\#(text)"}"#
            XCTAssertEqual(feed(json + "\n\n"), [.error(.upstream)], text)
        }
        XCTAssertEqual(feed(#"data: {"type":"error"}"# + "\n\n"), [.error(.upstream)])
        XCTAssertEqual(feed(#"data: {"type":"error","errorText":3}"# + "\n\n"), [.error(.upstream)])
    }

    func testReasoningToolDenialAndMetadataAreRead() {
        let trace = String(repeating: "a1", count: 16)
        let text = """
        data: {"type":"start","messageId":"m","messageMetadata":{"createdAt":1700000000000,"traceId":"\(trace)"}}

        data: {"type":"reasoning-start","id":"r"}

        data: {"type":"reasoning-delta","id":"r","delta":"hmm"}

        data: {"type":"reasoning-end","id":"r"}

        data: {"type":"tool-output-denied","toolCallId":"c"}

        data: {"type":"finish","messageMetadata":{"traceId":"\(trace)"}}


        """
        XCTAssertEqual(feed(text), [
            .messageStart(messageID: "m", conversationID: nil, title: nil, createdAt: Date(timeIntervalSince1970: 1_700_000_000), traceID: trace),
            .reasoningStart(id: "r"), .reasoningDelta(id: "r", delta: "hmm"), .reasoningEnd(id: "r"),
            .toolOutputDenied(toolCallID: "c"),
            .finish(conversationID: nil, title: nil, traceID: trace)
        ])
    }

    func testAMalformedTraceIDIsDropped() {
        let text = #"data: {"type":"start","messageMetadata":{"traceId":"not-a-trace"}}"# + "\n\n"
        XCTAssertEqual(feed(text), [.messageStart(messageID: nil, conversationID: nil, title: nil)])
    }
}
