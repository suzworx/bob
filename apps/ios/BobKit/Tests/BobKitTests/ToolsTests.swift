import XCTest
@testable import BobKit

private func toolsJSON(canEdit: Bool = true, preference: String = "null", enabled: Bool = true, blocked: String = "[]", availability: String = "context_dependent") -> String {
    #"{"scope":{"scope":"space","scopeId":"server-space"},"canEdit":\#(canEdit),"tools":[{"id":"calendar","toolName":"list_events","name":"Calendar","description":"Read your events","group":"Planning","integrationKind":null,"availability":"\#(availability)","enabled":\#(enabled),"preference":\#(preference),"blockedBy":\#(blocked)}]}"#
}
private func toolsCatalog(canEdit: Bool = true, preference: String = "null", enabled: Bool = true, blocked: String = "[]", availability: String = "context_dependent") throws -> ToolCatalog {
    try JSONDecoder().decode(ToolCatalog.self, from: Data(toolsJSON(canEdit: canEdit, preference: preference, enabled: enabled, blocked: blocked, availability: availability).utf8))
}

final class ToolsClientTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> ToolsClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return ToolsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
    }
    func testCatalogAuthenticatesAndEncodesEachContext() async throws {
        ProductivityStub.route("GET /api/tools", 200, toolsJSON())
        for (context, expected) in [(ToolContext.account, ""), (.integration("a+b"), "integrationId=a%2Bb"), (.space("s1"), "spaceId=s1"), (.conversation("c1"), "conversationId=c1")] {
            let catalog = try await client().catalog(context: context)
            XCTAssertEqual(ProductivityStub.last?.query ?? "", expected)
            XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
            XCTAssertEqual(catalog.scope.scopeID, "server-space")
        }
    }
    func testResetSendsExplicitNullAndServerScope() async throws {
        ProductivityStub.route("PATCH /api/tools/preferences", 200, toolsJSON())
        let scope = try toolsCatalog().scope
        _ = try await client().set(scope: scope, toolID: "calendar", enabled: nil)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["scope"] as? String, "space")
        XCTAssertEqual(body["scopeId"] as? String, "server-space")
        XCTAssertEqual(body["toolId"] as? String, "calendar")
        XCTAssertTrue(body["enabled"] is NSNull)
        _ = try await client().set(scope: scope, toolID: "calendar", enabled: false)
        XCTAssertEqual(ProductivityStub.last?.body?["enabled"] as? Bool, false)
    }
    func testNoSessionMakesNoRequest() async {
        do { _ = try await client(token: nil).catalog(context: .account); XCTFail("Must authenticate") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testRefusalAndMalformedCatalogAreNotEmptySuccess() async {
        ProductivityStub.route("GET /api/tools", 403, #"{"error":{"code":"forbidden"}}"#)
        do { _ = try await client().catalog(context: .account); XCTFail("Must refuse") }
        catch { XCTAssertEqual(error as? ApiError, .forbidden) }
        ProductivityStub.route("GET /api/tools", 200, "{}")
        do { _ = try await client().catalog(context: .account); XCTFail("Must decode contract") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testInheritedBlockIgnoresOwnScopeButExplainsParent() throws {
        let own = try toolsCatalog(blocked: #"[{"scope":"space","scopeId":"server-space"}]"#)
        XCTAssertNil(own.tools[0].disabledReason(in: own))
        let parent = try toolsCatalog(blocked: #"[{"scope":"account","scopeId":"owner"}]"#)
        XCTAssertEqual(parent.tools[0].disabledReason(in: parent), "Turned off for your account. Change that setting first.")
        XCTAssertNotNil(try toolsCatalog(canEdit: false).tools[0].disabledReason(in: toolsCatalog(canEdit: false)))
        let unavailable = try toolsCatalog(availability: "unavailable")
        XCTAssertNotNil(unavailable.tools[0].disabledReason(in: unavailable))
    }
}

@MainActor final class ToolsModelTests: XCTestCase {
    func testFailedSaveKeepsConfirmedStateAndRetryUsesServerScope() async throws {
        let original = try toolsCatalog()
        let writer = ToolWriteStub(result: try toolsCatalog(preference: "false", enabled: false))
        let model = ToolsModel(context: .space("requested"), read: { _ in original }, write: { try await writer.save($0, $1, $2) })
        await model.refresh()
        await model.save(toolID: "calendar", enabled: false)
        XCTAssertEqual(model.catalog, original)
        XCTAssertEqual(model.saveError, .offline)
        await model.save(toolID: "calendar", enabled: false)
        XCTAssertFalse(try XCTUnwrap(model.catalog?.tools.first).enabled)
        XCTAssertNil(model.saveError)
        let scope = await writer.scope
        XCTAssertEqual(scope, original.scope)
    }
    func testReadOnlyCatalogCannotWriteAndInheritedResetRemainsAvailable() async throws {
        let original = try toolsCatalog(canEdit: false)
        let writer = ToolWriteStub(result: original)
        let model = ToolsModel(context: .account, read: { _ in original }, write: { try await writer.save($0, $1, $2) })
        await model.refresh()
        await model.save(toolID: "calendar", enabled: false)
        let count = await writer.count
        XCTAssertEqual(count, 0)
        let blocked = try toolsCatalog(preference: "true", blocked: #"[{"scope":"account","scopeId":"owner"}]"#)
        let reset = ToolsModel(context: .space("s"), read: { _ in blocked }, write: { _, _, enabled in
            XCTAssertNil(enabled)
            return blocked
        })
        await reset.refresh()
        await reset.save(toolID: "calendar", enabled: nil)
        XCTAssertNil(reset.saveError)
    }
    func testCancelledOrOldLoadCannotRestoreCatalog() async throws {
        let gate = ToolReadGate()
        let model = ToolsModel(context: .account, read: { _ in try await gate.read() }, write: { _, _, _ in throw ApiError.offline })
        let read = Task { await model.refresh() }
        await gate.wait()
        model.cancel()
        await gate.finish(try toolsCatalog())
        await read.value
        XCTAssertNil(model.catalog)
        let cancelled = ToolsModel(context: .account, read: { _ in throw ApiError.cancelled }, write: { _, _, _ in throw ApiError.offline })
        await cancelled.refresh()
        XCTAssertNotEqual(cancelled.phase, .failed(.cancelled))
    }
    func testFailedLoadCanRetryAndNeverLooksLikeAnEmptyCatalog() async throws {
        let reader = ToolWriteStub(result: try toolsCatalog())
        let model = ToolsModel(context: .account, read: { _ in try await reader.save(ToolScopeRef(scope: .account, scopeID: "owner"), "read", nil) }, write: { _, _, _ in throw ApiError.offline })
        await model.refresh()
        XCTAssertEqual(model.phase, .failed(.offline))
        XCTAssertNil(model.catalog)
        await model.refresh()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.catalog?.tools.count, 1)
    }
    func testOldSaveCannotReplaceReopenedSettingsAndBusyCannotDoubleWrite() async throws {
        let original = try toolsCatalog()
        let gate = ToolReadGate()
        let model = ToolsModel(context: .space("requested"), read: { _ in original }, write: { _, _, _ in try await gate.read() })
        await model.refresh()
        let save = Task { await model.save(toolID: "calendar", enabled: false) }
        await gate.wait()
        XCTAssertEqual(model.busyID, "calendar")
        await model.save(toolID: "calendar", enabled: true)
        model.cancel()
        await model.refresh()
        await gate.finish(try toolsCatalog(preference: "false", enabled: false))
        await save.value
        XCTAssertEqual(model.catalog, original)
        XCTAssertNil(model.busyID)
    }
    func testInheritedBlockCannotBeOverriddenByToggle() async throws {
        let original = try toolsCatalog(blocked: #"[{"scope":"account","scopeId":"owner"}]"#)
        let writer = ToolWriteStub(result: original)
        let model = ToolsModel(context: .space("s"), read: { _ in original }, write: { try await writer.save($0, $1, $2) })
        await model.refresh()
        await model.save(toolID: "calendar", enabled: true)
        let count = await writer.count
        XCTAssertEqual(count, 0)
    }
    func testSearchIncludesGroupAndToolName() async throws {
        let original = try toolsCatalog()
        let model = ToolsModel(context: .account, read: { _ in original }, write: { _, _, _ in original })
        await model.refresh()
        model.query = "  LIST_EVENTS "
        XCTAssertEqual(model.groups.first?.tools.count, 1)
        model.query = "planning"
        XCTAssertEqual(model.groups.count, 1)
        model.query = "missing"
        XCTAssertTrue(model.groups.isEmpty)
    }
}

private actor ToolWriteStub {
    let result: ToolCatalog
    var count = 0
    var scope: ToolScopeRef?
    init(result: ToolCatalog) { self.result = result }
    func save(_ scope: ToolScopeRef, _ id: String, _ enabled: Bool?) throws -> ToolCatalog {
        count += 1; self.scope = scope
        if count == 1 { throw ApiError.offline }
        return result
    }
}
private actor ToolReadGate {
    var pending: CheckedContinuation<ToolCatalog, Error>?
    var waiter: CheckedContinuation<Void, Never>?
    func read() async throws -> ToolCatalog {
        try await withCheckedThrowingContinuation { pending = $0; waiter?.resume(); waiter = nil }
    }
    func wait() async { if pending == nil { await withCheckedContinuation { waiter = $0 } } }
    func finish(_ result: ToolCatalog) { pending?.resume(returning: result); pending = nil }
}
