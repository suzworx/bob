import XCTest
@testable import BobKit

final class MarketingChatBindingTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private let installationID = "11111111-1111-4111-8111-111111111111"
    private let campaignID = "22222222-2222-4222-8222-222222222222"
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return URLSession(configuration: config)
    }
    func testRunNewEncodesExplicitNullAndRefineOmitsCampaign() throws {
        let run = ChatAppBinding(installationID: installationID, mode: .run, campaignID: nil, channel: .instagram)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(run)) as? [String: Any]
        XCTAssertTrue(object?["campaignId"] is NSNull)
        XCTAssertEqual(object?["channel"] as? String, "instagram")
        let refine = ChatAppBinding(installationID: installationID, mode: .refine, campaignID: campaignID)
        let refined = try JSONSerialization.jsonObject(with: JSONEncoder().encode(refine)) as? [String: Any]
        XCTAssertNil(refined?["campaignId"])
        XCTAssertEqual(refined?["mode"] as? String, "refine")
    }
    func testPrivateChatCapturesBindingAndOrdinaryNextRequestOmitsIt() async throws {
        ProductivityStub.route("POST /api/chat", 200, "data: [DONE]\n\n")
        let client = ChatClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        let binding = ChatAppBinding(installationID: installationID, mode: .run, campaignID: campaignID)
        for try await _ in client.send(text: "Make a post", messageID: "message-1", appBinding: binding) {}
        let body = ProductivityStub.last?.body?["appBinding"] as? [String: Any]
        XCTAssertEqual(body?["campaignId"] as? String, campaignID)
        XCTAssertEqual(body?["installationId"] as? String, installationID)
        for try await _ in client.send(text: "Hello", messageID: "message-2") {}
        XCTAssertNil(ProductivityStub.last?.body?["appBinding"])
    }
    func testSharedInvocationCapturesSameBindingAndConflictIsNotBusy() async throws {
        ProductivityStub.route("POST /api/threads/thread-1/invocations", 201, #"{"invocation_id":"invocation-1"}"#)
        let client = ThreadsClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        let binding = ChatAppBinding(installationID: installationID, mode: .run, campaignID: nil)
        _ = try await client.invoke(threadID: "thread-1", triggerMessageID: "message-1", appBinding: binding)
        let body = ProductivityStub.last?.body?["appBinding"] as? [String: Any]
        XCTAssertTrue(body?["campaignId"] is NSNull)
        ProductivityStub.route("POST /api/threads/thread-1/invocations", 409, #"{"error":{"code":"conflict"}}"#)
        do { _ = try await client.askBob(threadID: "thread-1", triggerMessageID: "message-1", appBinding: binding); XCTFail("App conflict requires refreshing target") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 409)) }
    }
    func testInvalidBindingRefusesBeforeNetwork() async {
        let client = ChatClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        do {
            for try await _ in client.send(text: "Hi", messageID: "message-1", appBinding: ChatAppBinding(installationID: "bad", mode: .run)) {}
            XCTFail()
        } catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
}
