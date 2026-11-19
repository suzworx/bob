import XCTest
@testable import BobKit

private let adminAccountID = "11111111-1111-4111-8111-111111111111"
private let adminAccountJSON = #"{"id":"11111111-1111-4111-8111-111111111111","email":"person@example.test","createdAt":"2026-10-01T00:00:00Z","lastSignInAt":null,"status":"enabled","isAdmin":false,"emailConfirmed":true}"#
private let accountsJSON = #"{"accounts":[\#(adminAccountJSON)],"counts":{"total":1,"enabled":1,"disabled":0,"awaitingConfirmation":0},"nextCursor":"cursor_1"}"#
final class NativeAdminTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
        return URLSession(configuration: config)
    }
    private func client(token: String? = "tok") -> AdminClient {
        AdminClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { token })
    }
    func testAccessProbesAreIndependentAndRefusalHidden() async throws {
        ProductivityStub.route("GET /api/admin/access", 204, "")
        ProductivityStub.route("GET /api/operator/access", 404, #"{"error":{"code":"not_found"}}"#)
        let admin = try await client().access(.admin)
        let metrics = try await client().access(.metrics)
        XCTAssertTrue(admin); XCTAssertFalse(metrics)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testUnexpectedProbeResponseIsNotPermission() async {
        ProductivityStub.route("GET /api/admin/access", 200, "{}")
        do { _ = try await client().access(.admin); XCTFail() } catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testAccountSearchPostsQueryAndOpaqueCursorWithoutPIIInURL() async throws {
        ProductivityStub.route("POST /api/admin/accounts/search", 200, accountsJSON)
        let page = try await client().accounts(query: " person@ ", cursor: "cursor_1")
        XCTAssertEqual(page.accounts.first?.id, adminAccountID)
        XCTAssertNil(ProductivityStub.last?.query)
        XCTAssertEqual(ProductivityStub.last?.body?["query"] as? String, "person@")
        XCTAssertEqual(ProductivityStub.last?.body?["cursor"] as? String, "cursor_1")
        XCTAssertEqual(ProductivityStub.last?.body?["limit"] as? Int, 25)
    }
    func testManageAndInvitationUseExactActionsAndFailedInviteIsNotSent() async throws {
        ProductivityStub.route("POST /api/admin/accounts/manage", 200, #"{"status":"updated"}"#)
        try await client().manage(accountID: adminAccountID, action: .disable)
        XCTAssertEqual(ProductivityStub.last?.body?["action"] as? String, "disable")
        ProductivityStub.route("POST /api/admin/accounts", 200, #"{"status":"exists","invitation":"failed"}"#)
        let result = try await client().invite(email: " Person@Example.test ", retry: true)
        XCTAssertEqual(result.invitation, .failed)
        XCTAssertEqual(ProductivityStub.last?.body?["email"] as? String, "person@example.test")
        XCTAssertEqual(ProductivityStub.last?.body?["retryInvitation"] as? Bool, true)
    }
    func testInvalidAndUnauthenticatedMutationsNeverSend() async {
        do { try await client().manage(accountID: "bad", action: .disable); XCTFail() } catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        do { _ = try await client(token: nil).invite(email: "person@example.test", retry: false); XCTFail() } catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testMetricSchemaRejectsUnexpectedFieldsAndSuppressesSmallUserCounts() throws {
        let safe = #"{"window":{"from":"2026-10-01","to":"2026-10-02","bucket":"day"},"accounts":{"total":10,"enabled":9,"disabled":1,"awaitingConfirmation":0},"signups":1,"signups_by_bucket":[],"active_users":{"day":null,"week":2,"month":4,"in_window":null},"activated_users":1,"waitlist":{"total":0,"verified":0,"pending":0,"withAccount":0,"waitingVerified":0}}"#
        let doc = try OperatorMetricsDocument.decode(Data(safe.utf8), page: .users)
        XCTAssertEqual(doc.blocks.first(where: { $0.id == "active_users" })?.facts.first(where: { $0.label == "Week" })?.value, "Hidden")
        XCTAssertTrue(doc.blocks.flatMap(\.facts).contains { $0.label == "Activated users" && $0.value == "Hidden" })
        XCTAssertThrowsError(try OperatorMetricsDocument.decode(Data(safe.replacingOccurrences(of: "\"signups\":1", with: "\"secret\":\"do-not-render\",\"signups\":1").utf8), page: .users))
    }
}

private let usersMetricsJSON = #"{"window":{"from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z","bucket":"day"},"accounts":{"total":10,"enabled":9,"disabled":1,"awaitingConfirmation":0},"signups":1,"signups_by_bucket":[{"t":"2026-10-01T00:00:00.000Z","count":3}],"active_users":{"day":null,"week":2,"month":4,"in_window":null},"activated_users":null,"waitlist":{"total":0,"verified":0,"pending":0,"withAccount":0,"waitingVerified":0}}"#
@MainActor final class NativeAdminStateTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client() -> AdminClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
        return AdminClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { "tok" })
    }
    func testOneProbeFailureDoesNotGrantOrHideOtherScope() async {
        let model = AdministrativeAccessModel { scope in
            if scope == .admin { throw ApiError.offline }
            return true
        }
        await model.refresh()
        XCTAssertFalse(model.admin); XCTAssertTrue(model.metrics); XCTAssertEqual(model.error, .offline)
    }
    func testAccessRevocationClearsLoadedPeopleOnMutationRefusal() async {
        ProductivityStub.route("GET /api/admin/access", 204, "")
        ProductivityStub.route("POST /api/admin/accounts/search", 200, accountsJSON)
        ProductivityStub.route("POST /api/admin/accounts/manage", 403, #"{"error":{"code":"forbidden"}}"#)
        let model = NativeAdminModel(client: client(), identity: { "22222222-2222-4222-8222-222222222222" })
        await model.load()
        XCTAssertTrue(model.allowed)
        guard let account = model.accounts.first else { XCTFail(); return }
        let result = await model.manage(account, action: .disable)
        XCTAssertFalse(result); XCTAssertFalse(model.allowed); XCTAssertTrue(model.accounts.isEmpty)
        XCTAssertNil(model.accountCounts); XCTAssertFalse(model.busy)
    }
    func testPaginationDeduplicatesAndPinsOriginalSearchUntilExplicitSearch() async {
        ProductivityStub.route("GET /api/admin/access", 204, "")
        ProductivityStub.route("POST /api/admin/accounts/search", 200, accountsJSON)
        let model = NativeAdminModel(client: client(), identity: { adminAccountID })
        model.query = "original"
        await model.load()
        model.query = "new unsent query"
        await model.load(more: true)
        XCTAssertEqual(model.accounts.count, 1)
        XCTAssertNil(model.nextCursor)
        XCTAssertEqual(ProductivityStub.last?.body?["query"] as? String, "original")
        XCTAssertFalse(model.accounts[0].actions(selfID: adminAccountID).contains(.disable))
    }
    func testOlderMetricRangeCannotReplaceNewRange() async throws {
        let gate = MetricReadGate()
        let model = OperatorMetricsModel(probe: { true }, read: { try await gate.read($0, $1) })
        let old = Task { await model.refresh() }
        await gate.wait()
        model.range = .day
        await model.refresh()
        await gate.release()
        await old.value
        XCTAssertEqual(model.documents.first?.blocks.first(where: { $0.id == "signups" })?.facts.first?.value, "7")
        XCTAssertEqual(model.documents.first?.blocks.first(where: { $0.id == "signups_by_bucket" })?.points.count, 1)
    }
    func testMetricsRefusedProbeNeverReadsDocuments() async {
        let model = OperatorMetricsModel(probe: { false }, read: { _, _ in XCTFail("Must not read without permission"); throw ApiError.offline })
        await model.refresh()
        XCTAssertTrue(model.documents.isEmpty)
        XCTAssertFalse(model.allowed)
        XCTAssertEqual(model.phase, .failed(.forbidden))
    }
}
private actor MetricReadGate {
    private var held: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func read(_ page: OperatorMetricsPage, _ range: OperatorMetricsRange) async throws -> OperatorMetricsDocument {
        if range == .week { await withCheckedContinuation { held = $0; waiter?.resume(); waiter = nil } }
        let json = range == .day ? usersMetricsJSON.replacingOccurrences(of: "\"signups\":1", with: "\"signups\":7") : usersMetricsJSON
        return try OperatorMetricsDocument.decode(Data(json.utf8), page: page)
    }
    func wait() async { if held == nil { await withCheckedContinuation { waiter = $0 } } }
    func release() { held?.resume(); held = nil }
}

final class OperatorMetricsWireTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    func testAuthenticatedMetricRangeAndMalformedPayloadRefusal() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProductivityStub.self]
        let client = OperatorMetricsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { "tok" })
        ProductivityStub.route("GET /api/operator/metrics/users", 200, usersMetricsJSON)
        _ = try await client.document(page: .users, range: .quarter)
        XCTAssertEqual(ProductivityStub.last?.query, "range=90d")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        ProductivityStub.route("GET /api/operator/metrics/users", 200, "{}")
        do { _ = try await client.document(page: .users, range: .week); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 200)) }
    }
    func testSurfaceAndStageLabelsSurviveNestedMetricPresentation() throws {
        let surface: [String: Any] = ["turns": 3, "outcomes": ["completed": 3, "failed": 0, "cancelled": 0, "empty": 0], "success_rate": 1,
            "latency_ms": Dictionary(uniqueKeysWithValues: ["first_audio", "stt", "model", "tts", "total"].map { ($0, ["p50": 40, "p95": 80]) })]
        let object: [String: Any] = ["window": ["from": "2026-10-01", "to": "2026-10-02", "bucket": "day"], "by_surface": ["device": surface, "web_voice": surface, "web_text": surface], "failed_by_stage": ["input": 0, "stt": 0, "agent": 0, "tts": 0], "first_audio_p95_by_bucket": []]
        let document = try OperatorMetricsDocument.decode(JSONSerialization.data(withJSONObject: object), page: .voice)
        let facts = document.blocks.flatMap(\.facts)
        XCTAssertTrue(facts.contains { $0.label == "Device · Latency ms · Speech recognition · Median" && $0.value == "40 ms" })
        XCTAssertTrue(facts.contains { $0.label == "Web voice · Latency ms · Speech synthesis · 95th percentile" })
    }
}
