import XCTest
@testable import BobKit

private let routineID = "11111111-1111-4111-8111-111111111111"
private let accountID = "22222222-2222-4222-8222-222222222222"
private let routineJSON = #"{"id":"11111111-1111-4111-8111-111111111111","kind":"daily_gmail_digest","googleAccountId":"22222222-2222-4222-8222-222222222222","scheduledReadConsent":true,"weekdays":[1,3],"localTime":"08:30","timeZone":"America/Los_Angeles","name":"Morning recap","instructions":"Deadlines","gmailQuery":"label:work","summaryStyle":"concise","emailResult":false,"status":"active","revision":4,"nextRunAt":1700000000000,"createdAt":1700000000000,"updatedAt":1700000000000}"#

final class RoutinesTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> RoutinesClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return RoutinesClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
    }
    func testListIncludesArchivedAndDecodesWallClockWithoutConvertingZone() async throws {
        ProductivityStub.route("GET /api/routines", 200, #"{"routines":[\#(routineJSON)]}"#)
        let rows = try await client().list()
        XCTAssertEqual(ProductivityStub.last?.query, "includeArchived=true")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(rows.first?.localTime, "08:30")
        XCTAssertEqual(rows.first?.timeZone, "America/Los_Angeles")
        XCTAssertEqual(rows.first?.nextRunAt, Date(timeIntervalSince1970: 1700000000))
    }
    func testDraftRequiresConsentAndValidUniqueSchedule() {
        var draft = RoutineDraft(timeZone: "America/Los_Angeles")
        draft.googleAccountID = accountID
        XCTAssertFalse(draft.isValid)
        draft.scheduledReadConsent = true
        XCTAssertTrue(draft.isValid)
        for time in ["24:00", "08:60", "8:00", "08:00:00"] {
            draft.localTime = time
            XCTAssertFalse(draft.isValid)
        }
        draft.localTime = "08:00"
        draft.timeZone = "+05:00"
        XCTAssertFalse(draft.isValid)
        draft.timeZone = "UTC"
        draft.weekdays = [1,1]
        XCTAssertFalse(draft.isValid)
        draft.weekdays = []
        XCTAssertFalse(draft.isValid)
        draft.weekdays = [7]
        XCTAssertTrue(draft.isValid)
    }
    func testInvalidInputMakesNoRequest() async {
        do { _ = try await client().create(RoutineDraft()); XCTFail("Must refuse missing consent/account") }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testMissingSessionMakesNoRequest() async {
        do { _ = try await client(token: nil).list(); XCTFail("Must require account") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testPauseCarriesRevisionAndNoScheduledReadConsent() async throws {
        ProductivityStub.route("PATCH /api/routines/\(routineID)", 200, #"{"routine":\#(routineJSON)}"#)
        _ = try await client().setStatus(id: routineID, revision: 4, status: .paused)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 4)
        XCTAssertEqual(ProductivityStub.last?.body?["status"] as? String, "paused")
        XCTAssertNil(ProductivityStub.last?.body?["scheduledReadConsent"])
    }
    func testArchiveUsesRevisionGuardedDelete() async throws {
        ProductivityStub.route("DELETE /api/routines/\(routineID)", 204, "")
        try await client().archive(id: routineID, revision: 4)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 4)
    }
    func testCreateSendsConsentAndConfigurationWithoutAccountScopeOverride() async throws {
        ProductivityStub.route("POST /api/routines", 201, #"{"routine":\#(routineJSON)}"#)
        var draft = RoutineDraft(timeZone: "Asia/Kolkata")
        draft.googleAccountID = accountID
        draft.scheduledReadConsent = true
        draft.weekdays = [7, 1]
        draft.name = "  Recap  "
        _ = try await client().create(draft)
        let body = ProductivityStub.last?.body
        XCTAssertEqual(body?["kind"] as? String, "daily_gmail_digest")
        XCTAssertEqual(body?["scheduledReadConsent"] as? Bool, true)
        XCTAssertEqual(body?["googleAccountId"] as? String, accountID)
        XCTAssertEqual(body?["weekdays"] as? [Int], [1, 7])
        XCTAssertEqual(body?["timeZone"] as? String, "Asia/Kolkata")
        XCTAssertEqual(body?["name"] as? String, "Recap")
        XCTAssertNil(body?["userId"])
    }
    func testEditingKeepsConsentOnlyForOriginalAccount() async throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let routine = try decoder.decode(Routine.self, from: Data(routineJSON.utf8))
        var draft = RoutineDraft(routine: routine)
        XCTAssertTrue(draft.isValid)
        XCTAssertFalse(draft.needsConsent)
        draft.googleAccountID = "33333333-3333-4333-8333-333333333333"
        XCTAssertFalse(draft.isValid)
        draft.scheduledReadConsent = true
        XCTAssertTrue(draft.isValid)
        ProductivityStub.route("PATCH /api/routines/\(routineID)", 200, #"{"routine":\#(routineJSON)}"#)
        _ = try await client().update(routine, draft: draft)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 4)
        XCTAssertEqual(ProductivityStub.last?.body?["scheduledReadConsent"] as? Bool, true)
        XCTAssertEqual(ProductivityStub.last?.body?["googleAccountId"] as? String, draft.googleAccountID)
    }
    func testConflictRebaseKeepsDraftAndRequiresConsentIfSavedAccountChanged() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let original = try decoder.decode(Routine.self, from: Data(routineJSON.utf8))
        let latestJSON = routineJSON.replacingOccurrences(of: accountID, with: "33333333-3333-4333-8333-333333333333")
        let latest = try decoder.decode(Routine.self, from: Data(latestJSON.utf8))
        var draft = RoutineDraft(routine: original)
        draft.name = "My unsaved name"
        draft.rebase(on: latest)
        XCTAssertEqual(draft.name, "My unsaved name")
        XCTAssertEqual(draft.googleAccountID, accountID)
        XCTAssertTrue(draft.needsConsent)
        XCTAssertFalse(draft.isValid)
        draft.scheduledReadConsent = true
        XCTAssertTrue(draft.isValid)
    }
    func testRunHistoryPreservesFailedRunsAndLoadsExactRecap() async throws {
        let runID = "33333333-3333-4333-8333-333333333333"
        let json = #"{"id":"\#(runID)","routineId":"\#(routineID)","routineName":"Recap","scheduledAt":1700000000000,"startedAt":null,"completedAt":null,"status":"failed","failureCode":"consent_unavailable","emailOutcome":null,"result":null}"#
        ProductivityStub.route("GET /api/routines/\(routineID)/runs", 200, #"{"runs":[\#(json)]}"#)
        ProductivityStub.route("GET /api/routines/\(routineID)/runs/\(runID)", 200, #"{"run":\#(json)}"#)
        let runs = try await client().runs(id: routineID)
        XCTAssertEqual(runs.first?.status, .failed)
        XCTAssertNotNil(runs.first?.explanation)
        let run = try await client().run(id: routineID, runID: runID)
        XCTAssertEqual(run.id, runID)
        XCTAssertNil(run.result)
    }
    func testConflictIsPreservedRatherThanOptimisticSuccess() async {
        ProductivityStub.route("PATCH /api/routines/\(routineID)", 409, #"{"error":{"code":"conflict"}}"#)
        do { _ = try await client().setStatus(id: routineID, revision: 4, status: .paused); XCTFail("Must reject stale revision") }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 409)) }
    }
}
