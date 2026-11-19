import XCTest
@testable import BobKit

final class BobAppsTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> BobAppsClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
        return BobAppsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
    }
    func testListKeepsScopeAndCursorAuthenticated() async throws {
        ProductivityStub.route("GET /api/bob-apps", 200, #"{"apps":[],"nextCursor":null}"#)
        _ = try await client().list(spaceID: "space", cursor: "next")
        XCTAssertEqual(ProductivityStub.last?.query, "limit=20&spaceId=space&cursor=next")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testNoSessionCannotReadOrCreate() async {
        do { _ = try await client(token: nil).list(); XCTFail("Must authenticate") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
        do { _ = try await client(token: nil).create(.starter(.checklist), spaceID: nil, mutationID: UUID()); XCTFail("Must authenticate creation") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testStarterReferencesAndPreviewMetricsStayTyped() throws {
        let definition = BobAppDefinition.starter(.budget)
        XCTAssertTrue(definition.isValid)
        XCTAssertEqual(definition.views.map(\.kind), [.table, .dashboard, .slides])
        let records = ["items": [BobAppRecord(id: "r_one", values: ["title": .text("Lunch"), "amount": .number(12.5)])]]
        XCTAssertEqual(definition.previewMetrics(records)["total"], 12.5)
        let json = try JSONEncoder().encode(records)
        let roundtrip = try JSONDecoder().decode([String: [BobAppRecord]].self, from: json)
        XCTAssertEqual(roundtrip, records)
    }
    func testRecordDraftRejectsInvalidNumbersAndKeepsStableID() throws {
        let table = try XCTUnwrap(BobAppDefinition.starter(.budget).tables.first)
        var draft = BobAppRecordDraft(table: table)
        let id = draft.id
        draft.text["amount"] = "not a number"
        XCTAssertThrowsError(try draft.values(table: table, locale: Locale(identifier: "en_US")))
        draft.text["amount"] = "12.5"
        XCTAssertEqual(try draft.values(table: table, locale: Locale(identifier: "en_US"))["amount"], .number(12.5))
        XCTAssertEqual(draft.id, id)
        draft.text["amount"] = "1000000000001"
        XCTAssertThrowsError(try draft.values(table: table, locale: Locale(identifier: "en_US")))
    }
    func testRefreshScheduleNeedsExplicitValidDaysTimeAndZone() {
        var config = BobAppRefreshConfig(spaceId: "space", targetTable: "tasks", weekdays: [1], localTime: "08:30", timeZone: "America/Los_Angeles")
        XCTAssertTrue(config.isValid)
        config.schedule.weekdays = []; XCTAssertFalse(config.isValid)
        config.schedule.weekdays = [1]; config.schedule.localTime = "25:00"; XCTAssertFalse(config.isValid)
        config.schedule.localTime = "08:00"; config.schedule.timeZone = "Mars/City"; XCTAssertFalse(config.isValid)
    }
}

private func savedAppJSON(revision: Int = 1, lifecycle: String = "active", space: String? = nil, canManage: Bool = true) throws -> String {
    let definition = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BobAppDefinition.starter(.tasks)))
    let app: [String: Any] = ["id": "app1", "installationId": "install1", "spaceId": space as Any? ?? NSNull(), "canManage": canManage, "revision": revision, "lifecycle": lifecycle, "createdAt": 1700000000000, "updatedAt": 1700000000000, "definition": definition, "state": ["tasks": [["id": "r_one", "values": ["title": "Call Sam", "completed": false]]]], "metrics": ["items": 1], "pendingDefinition": NSNull(), "canUndo": true]
    return String(decoding: try JSONSerialization.data(withJSONObject: ["app": app]), as: UTF8.self)
}
private func appsClient() -> BobAppsClient {
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
    return BobAppsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { "tok" })
}

@MainActor final class BobAppsMutationTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func prepare(space: String? = nil, canManage: Bool = true, locked: Bool = false) throws {
        ProductivityStub.route("GET /api/bob-apps/app1", 200, try savedAppJSON(space: space, canManage: canManage))
        let config = locked ? #"{"source":"tasks","spaceId":"space","targetTable":"tasks","schedule":{"weekdays":[1],"localTime":"08:00","timeZone":"UTC"}}"# : "null"
        ProductivityStub.route("GET /api/bob-apps/app1/refresh", 200, #"{"enabled":\#(locked),"config":\#(config),"nextRunAt":null,"lastRefreshAt":null,"lastError":null}"#)
        ProductivityStub.route("GET /api/bob-apps/app1/runs", 200, #"{"runs":[]}"#)
    }
    func testMutationUsesPinnedRevisionAndStableCallerMutationID() async throws {
        try prepare()
        let client = appsClient(); let app = try await client.get("app1"); let mutationID = UUID()
        ProductivityStub.route("POST /api/bob-apps/app1/actions", 200, try savedAppJSON(revision: 2))
        let command = BobAppCommand.write(action: "update", id: "r_one", values: ["title": .text("Call Sam"), "completed": .boolean(true)])
        _ = try await client.act(app, command: command, expectedRevision: 1, mutationID: mutationID)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, mutationID.uuidString)
        let body = try XCTUnwrap(ProductivityStub.last?.body?["command"] as? [String: Any])
        XCTAssertEqual(body["operation"] as? String, "write")
        XCTAssertEqual(body["id"] as? String, "r_one")
    }
    func testConflictLoadsLatestButDoesNotReplayUnsavedRecord() async throws {
        try prepare()
        let model = BobAppsModel(client: appsClient(), appID: "app1"); await model.load()
        ProductivityStub.route("POST /api/bob-apps/app1/actions", 409, #"{"error":{"code":"conflict"}}"#)
        ProductivityStub.route("GET /api/bob-apps/app1", 200, try savedAppJSON(revision: 2))
        let saved = await model.act(.write(action: "update", id: "r_one", values: ["title": .text("Changed")]), revision: 1)
        XCTAssertFalse(saved); XCTAssertEqual(model.app?.revision, 2)
        XCTAssertTrue(model.message?.contains("changed elsewhere") == true)
        XCTAssertEqual(ProductivityStub.all.filter { $0.path.hasSuffix("actions") }.count, 1)
    }
    func testUncertainLifecycleRetryKeepsOriginalRevisionAndReceipt() async throws {
        try prepare()
        let model = BobAppsModel(client: appsClient(), appID: "app1")
        await model.load()
        // The server applied Undo, but its response was lost. A fresh read now sees revision 2.
        ProductivityStub.route("PATCH /api/bob-apps/app1", 503, #"{"error":{"code":"unavailable"}}"#)
        ProductivityStub.route("GET /api/bob-apps/app1", 200, try savedAppJSON(revision: 2))
        let uncertain = await model.change(.undo)
        XCTAssertNil(uncertain)
        XCTAssertEqual(model.app?.revision, 1)
        ProductivityStub.route("PATCH /api/bob-apps/app1", 200, try savedAppJSON(revision: 2))
        let replayed = await model.change(.undo)
        XCTAssertEqual(replayed?.revision, 2)
        let requests = ProductivityStub.all.filter { $0.method == "PATCH" }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].body?["mutationId"] as? String, requests[1].body?["mutationId"] as? String)
        XCTAssertEqual(requests[1].body?["expectedRevision"] as? Int, 1)
    }

    func testPrivateRecordsStayLockedWhenRefreshStateUnavailableOrTableManaged() async throws {
        try prepare(locked: true)
        let model = BobAppsModel(client: appsClient(), appID: "app1"); await model.load()
        XCTAssertEqual(model.lockedTable, "tasks")
        let result = await model.act(.delete(action: "delete", id: "r_one"), revision: 1)
        XCTAssertFalse(result)
        ProductivityStub.route("GET /api/bob-apps/app1/refresh", 503, #"{"error":{"code":"unavailable"}}"#)
        await model.load(); XCTAssertFalse(model.editable); XCTAssertNotNil(model.refreshError)
        XCTAssertFalse(ProductivityStub.all.contains { $0.method == "POST" })
    }
    func testSharedMemberCanEditRecordsButCannotManageLifecycle() async throws {
        try prepare(space: "space1", canManage: false)
        let model = BobAppsModel(client: appsClient(), spaceID: "space1", appID: "app1"); await model.load()
        XCTAssertTrue(model.editable)
        let changed = await model.change(.archive); XCTAssertNil(changed)
        XCTAssertFalse(ProductivityStub.all.contains { $0.method == "PATCH" })
    }
    func testWrongAudienceAndRevokedAccessClearTheOpenApp() async throws {
        try prepare(space: "other")
        let model = BobAppsModel(client: appsClient(), spaceID: "space1", appID: "app1"); await model.load()
        XCTAssertNil(model.app); XCTAssertEqual(model.phase, .failed(.notFound))
        try prepare(space: "space1"); await model.load(); XCTAssertNotNil(model.app)
        ProductivityStub.route("GET /api/bob-apps/app1", 404, #"{"error":{"code":"not_found"}}"#)
        await model.load(); XCTAssertNil(model.app); XCTAssertFalse(model.editable)
    }
    func testConversationBodyAbsentAndWrongReturnedAudienceRejected() async throws {
        try prepare(space: "space1")
        ProductivityStub.route("POST /api/bob-apps/app1/conversation", 200, #"{"conversationId":"thread1","spaceId":"other"}"#)
        let model = BobAppsModel(client: appsClient(), spaceID: "space1", appID: "app1"); await model.load()
        let conversation = await model.conversation(); XCTAssertNil(conversation)
        XCTAssertNil(ProductivityStub.last?.body)
        XCTAssertNotNil(model.message)
    }
    func testRefreshConsentAndNullPauseConfigAreExplicit() async throws {
        try prepare()
        let client = appsClient(); let app = try await client.get("app1")
        ProductivityStub.route("PUT /api/bob-apps/app1/refresh", 200, #"{"enabled":false,"config":null,"nextRunAt":null,"lastRefreshAt":null,"lastError":null}"#)
        _ = try await client.configure(app, enabled: false, config: nil, mutationID: UUID())
        XCTAssertEqual(ProductivityStub.last?.body?["consent"] as? Bool, true)
        XCTAssertTrue(ProductivityStub.last?.body?["config"] is NSNull)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 1)
    }
    func testMalformedDefinitionRejectedBeforeRendering() async throws {
        let bad = try savedAppJSON().replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2")
        ProductivityStub.route("GET /api/bob-apps/app1", 200, bad)
        do { _ = try await appsClient().get("app1"); XCTFail("Unsupported definitions cannot render") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testRefreshRetryReusesReceiptAfterLostReadback() async throws {
        try prepare()
        let model = BobAppsModel(client: appsClient(), appID: "app1"); await model.load()
        ProductivityStub.route("PUT /api/bob-apps/app1/refresh", 200, #"{"enabled":false,"config":null,"nextRunAt":null,"lastRefreshAt":null,"lastError":null}"#)
        ProductivityStub.route("GET /api/bob-apps/app1", 503, #"{"error":{"code":"unavailable"}}"#)
        let first = await model.configure(enabled: false, config: nil); XCTAssertFalse(first)
        ProductivityStub.route("GET /api/bob-apps/app1", 200, try savedAppJSON(revision: 2))
        let second = await model.configure(enabled: false, config: nil); XCTAssertTrue(second)
        let requests = ProductivityStub.all.filter { $0.method == "PUT" }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.first?.body?["mutationId"] as? String, requests.last?.body?["mutationId"] as? String)
    }
    func testRetryKeepsMutationIDForTheSamePinnedRecordChange() async throws {
        try prepare()
        let model = BobAppsModel(client: appsClient(), appID: "app1"); await model.load()
        ProductivityStub.route("POST /api/bob-apps/app1/actions", 503, #"{"error":{"code":"unavailable"}}"#)
        _ = await model.act(.write(action: "update", id: "r_one", values: ["title": .text("Changed"), "completed": .boolean(true)]), revision: 1)
        _ = await model.act(.write(action: "update", id: "r_one", values: ["completed": .boolean(true), "title": .text("Changed")]), revision: 1)
        let requests = ProductivityStub.all.filter { $0.path.hasSuffix("actions") }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.first?.body?["mutationId"] as? String, requests.last?.body?["mutationId"] as? String)
    }
    func testInvalidRefreshStateNeverUnlocksPrivateRecords() async throws {
        try prepare()
        ProductivityStub.route("GET /api/bob-apps/app1/refresh", 200, #"{"enabled":true,"config":null,"nextRunAt":null,"lastRefreshAt":null,"lastError":null}"#)
        let model = BobAppsModel(client: appsClient(), appID: "app1"); await model.load()
        XCTAssertFalse(model.editable); XCTAssertEqual(model.refreshError, .unknown(status: 200))
    }
    func testCancelledReadDoesNotDisplayAnApp() async throws {
        try prepare()
        let model = BobAppsModel(client: appsClient(), appID: "app1")
        let task = Task { await model.load() }; task.cancel(); await task.value
        XCTAssertNil(model.app)
    }
}
