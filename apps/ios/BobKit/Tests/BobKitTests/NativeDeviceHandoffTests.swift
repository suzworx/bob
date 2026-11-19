import XCTest
@testable import BobKit

final class NativeDeviceHandoffTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> DevicesClient {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ProductivityStub.self]
        return DevicesClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), accessToken: { token })
    }
    func testOfflineReceiptIsPendingAndTargetsOnlySelectedDevice() async throws {
        ProductivityStub.route("PUT /api/devices/active-conversation", 202, #"{"status":"pending"}"#)
        let receipt = try await client().handoff(deviceID: "d1", target: .conversation(id: "conversation1", spaceID: nil))
        XCTAssertEqual(receipt, .pending)
        XCTAssertEqual(ProductivityStub.last?.body?["device_id"] as? String, "d1")
        XCTAssertEqual(ProductivityStub.last?.body?["conversation_id"] as? String, "conversation1")
        XCTAssertTrue(ProductivityStub.last?.body?["space_id"] is NSNull)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testNewConversationClearsPointerAndUsesExplicitSpace() async throws {
        ProductivityStub.route("PUT /api/devices/active-conversation", 200, #"{"active_conversation":null,"active_space":null}"#)
        let receipt = try await client().handoff(deviceID: "d1", target: .newConversation(spaceID: nil))
        XCTAssertEqual(receipt, .sent)
        XCTAssertTrue(ProductivityStub.last?.body?["conversation_id"] is NSNull)
        XCTAssertTrue(ProductivityStub.last?.body?["space_id"] is NSNull)
        XCTAssertNil(ProductivityStub.last?.body?["thread_id"])
    }
    func testThreadHandoffKeepsThreadAndSpaceTogether() async throws {
        ProductivityStub.route("PUT /api/devices/active-conversation", 200, #"{"active_conversation":{"id":"thr_t1","title":"Trip"},"active_space":{"id":"space1","name":"Family"}}"#)
        _ = try await client().handoff(deviceID: "d2", target: .thread(id: "t1", spaceID: "space1"))
        XCTAssertTrue(ProductivityStub.last?.body?["conversation_id"] is NSNull)
        XCTAssertEqual(ProductivityStub.last?.body?["thread_id"] as? String, "t1")
        XCTAssertEqual(ProductivityStub.last?.body?["space_id"] as? String, "space1")
    }
    func testRefusalAndMalformedResponseNeverClaimSent() async {
        ProductivityStub.route("PUT /api/devices/active-conversation", 404, #"{"error":{"code":"not_found"}}"#)
        do { _ = try await client().handoff(deviceID: "d1", target: .newConversation(spaceID: nil)); XCTFail("Must refuse") }
        catch { XCTAssertEqual(error as? ApiError, .notFound) }
        ProductivityStub.route("PUT /api/devices/active-conversation", 200, "{}")
        do { _ = try await client().handoff(deviceID: "d1", target: .newConversation(spaceID: nil)); XCTFail("Must validate receipt") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testNoSessionCannotChangeAnyDevice() async {
        do { _ = try await client(token: nil).handoff(deviceID: "d1", target: .newConversation(spaceID: nil)); XCTFail("Must authenticate") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
}
