import XCTest
@testable import BobKit

final class ChatAttachmentsTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    func testAttachmentsCannotBypassAnExistingStreamingTurn() throws {
        var transcript = ChatTranscript()
        XCTAssertTrue(transcript.canSend(draft: "", hasAttachments: true))
        transcript.beginTurn(userMessageID: "person", replyMessageID: "reply", text: "Hi", at: Date())
        XCTAssertFalse(transcript.canSend(draft: "", hasAttachments: true))
    }

    func testBatchLimitsAreAtomicAndCheckDecodedBytes() throws {
        let full = try ChatOutgoingAttachment(name: "notes.txt", mediaType: "text/plain", data: Data(repeating: 65, count: 4 * 1024 * 1024))
        XCTAssertNoThrow(try ChatOutgoingAttachment.validate([full, full]))
        XCTAssertThrowsError(try ChatOutgoingAttachment.validate([full, full, full]))
        XCTAssertThrowsError(try ChatOutgoingAttachment(name: "big.txt", mediaType: "text/plain", data: Data(repeating: 65, count: 4 * 1024 * 1024 + 1)))
        let small = try ChatOutgoingAttachment(name: "tiny.txt", mediaType: "text/plain", data: Data("hello".utf8))
        XCTAssertThrowsError(try ChatOutgoingAttachment.validate(Array(repeating: small, count: 5)))
        XCTAssertThrowsError(try ChatOutgoingAttachment(name: "index.html", mediaType: "text/html", data: Data("Hi".utf8)))
    }
    func testAttachmentOnlyMessageSendsAuthenticatedInlineFilePart() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        let client = ChatClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), accessToken: { "tok" })
        ProductivityStub.route("POST /api/chat", 200, "data: [DONE]\n\n")
        let attachment = try ChatOutgoingAttachment(name: "notes.txt", mediaType: "text/plain", data: Data("Hello".utf8))
        for try await _ in client.send(text: "", messageID: "message-1", attachments: [attachment]) {}
        let message = ProductivityStub.last?.body?["message"] as? [String: Any]
        let parts = message?["parts"] as? [[String: Any]]
        XCTAssertEqual(parts?.count, 1)
        XCTAssertEqual(parts?.first?["type"] as? String, "file")
        XCTAssertEqual(parts?.first?["filename"] as? String, "notes.txt")
        XCTAssertEqual(parts?.first?["url"] as? String, "data:text/plain;base64,SGVsbG8=")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testTranscriptRetainsAttachmentForImmediateRenderAndFailedRetry() throws {
        let attachment = try ChatOutgoingAttachment(name: "notes.txt", mediaType: "text/plain", data: Data("Hello".utf8))
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "u1", replyMessageID: "a1", text: "", attachments: [attachment.display])
        XCTAssertTrue(transcript.isStreaming)
        XCTAssertEqual(transcript.lastPersonMessage?.attachments.first?.decodedData(), Data("Hello".utf8))
        transcript.fail(.offline)
        let recovered = try ChatOutgoingAttachment(stored: XCTUnwrap(transcript.lastPersonMessage?.attachments.first))
        XCTAssertEqual(recovered.data, attachment.data)
    }
    func testRegeneratingAttachmentOnlyMessageStillSendsNonemptyPartsArray() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        let client = ChatClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), accessToken: { "tok" })
        ProductivityStub.route("POST /api/chat", 200, "data: [DONE]\n\n")
        for try await _ in client.send(text: "", messageID: "existing-file-message", conversationID: "conversation-1", turn: .regenerate) {}
        let message = ProductivityStub.last?.body?["message"] as? [String: Any]
        XCTAssertEqual((message?["parts"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["regenerate"] as? Bool, true)
    }
    func testStoredRemoteLinkNeverBecomesOutgoingFile() {
        let remote = ChatAttachment(name: "notes.txt", mediaType: "text/plain", url: "https://example.test/private")
        XCTAssertThrowsError(try ChatOutgoingAttachment(stored: remote))
    }
}
