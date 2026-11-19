import XCTest
@testable import BobKit

final class BobAppImprovementTests: XCTestCase {
    private let appID = "a0000000-0000-0000-0000-000000000001"
    private let installationID = "b0000000-0000-0000-0000-000000000001"
    override func setUp() { ProductivityStub.reset() }
    private func client() -> BobAppsClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
        return BobAppsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { "token" })
    }
    private func app(space: String? = nil, installation: String? = nil, lifecycle: String = "active", canManage: Bool = true) throws {
        let definition = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BobAppDefinition.starter(.tasks)))
        let body: [String: Any] = ["id": appID, "installationId": installation ?? installationID, "spaceId": space as Any? ?? NSNull(), "canManage": canManage, "revision": 7, "lifecycle": lifecycle, "createdAt": 1700000000000, "updatedAt": 1700000000000, "definition": definition, "state": [:], "metrics": [:], "pendingDefinition": NSNull(), "canUndo": false]
        ProductivityStub.route("GET /api/bob-apps/\(appID)", 200, String(decoding: try JSONSerialization.data(withJSONObject: ["app": body]), as: UTF8.self))
    }
    func testPrivateImprovementBindsExactInstallationWithoutCreatingSharedThread() async throws {
        try app()
        let context = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: nil)
        XCTAssertEqual(context.app.revision, 7)
        XCTAssertNil(context.conversation)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(context.binding)) as? [String: String])
        XCTAssertEqual(body, ["installationId": installationID, "mode": "refine"])
        XCTAssertEqual(ProductivityStub.all.count, 1)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer token")
    }
    func testAudienceOrInstallationMismatchCannotOpenAnyConversation() async throws {
        for mismatch in ["audience", "installation"] {
            ProductivityStub.reset()
            try app(space: mismatch == "audience" ? "other-space" : nil, installation: mismatch == "installation" ? UUID().uuidString : nil)
            do { _ = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: nil); XCTFail("Must refuse mismatch") }
            catch { XCTAssertEqual(error as? ApiError, .forbidden) }
            XCTAssertEqual(ProductivityStub.all.count, 1)
        }
    }
    func testInactiveAppsCannotStartImprovement() async throws {
        for lifecycle in ["paused", "archived"] {
            try app(lifecycle: lifecycle)
            do { _ = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: nil); XCTFail("Must refuse") }
            catch { XCTAssertEqual(error as? ApiError, .forbidden) }
        }
    }
    func testSharedAnchorMustMatchExactAudience() async throws {
        let space = "c0000000-0000-0000-0000-000000000001"
        try app(space: space, canManage: false)
        ProductivityStub.route("POST /api/bob-apps/\(appID)/conversation", 200, #"{"conversationId":"d0000000-0000-0000-0000-000000000001","spaceId":"wrong"}"#)
        do { _ = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: space); XCTFail("Must refuse wrong audience") }
        catch { XCTAssertEqual(error as? ApiError, .forbidden) }
        ProductivityStub.route("POST /api/bob-apps/\(appID)/conversation", 200, "{\"conversationId\":\"d0000000-0000-0000-0000-000000000001\",\"spaceId\":\"\(space)\"}")
        let context = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: space)
        XCTAssertEqual(context.conversation?.spaceId, space)
        XCTAssertThrowsError(try context.validateThread(id: "other", spaceID: space, archived: false))
        XCTAssertThrowsError(try context.validateThread(id: context.conversation!.conversationId, spaceID: space, archived: true))
        XCTAssertNoThrow(try context.validateThread(id: context.conversation!.conversationId, spaceID: space, archived: false))
    }
    func testCancelledOpenNeverStartsNetworkOrCreatesFallback() async {
        let client = client(), appID = appID, installationID = installationID
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await BobAppImprovementContext.open(client: client, appID: appID, installationID: installationID, spaceID: nil)
        }
        do { _ = try await task.value; XCTFail("Must cancel") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }
    func testMissingAppPropagatesWithoutOpeningOrdinaryChat() async {
        ProductivityStub.route("GET /api/bob-apps/\(appID)", 404, #"{"error":{"code":"not_found"}}"#)
        do { _ = try await BobAppImprovementContext.open(client: client(), appID: appID, installationID: installationID, spaceID: nil); XCTFail("Must refuse") }
        catch { XCTAssertEqual(error as? ApiError, .notFound) }
        XCTAssertEqual(ProductivityStub.all.count, 1)
    }

}
