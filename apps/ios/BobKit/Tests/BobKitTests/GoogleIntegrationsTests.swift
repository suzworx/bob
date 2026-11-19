import XCTest
@testable import BobKit

private let googleAccountID = "11111111-1111-4111-8111-111111111111"
private let googleAccountJSON = #"{"id":"11111111-1111-4111-8111-111111111111","email":"person@example.test","name":"Person","customName":"Work","selected":true,"createdAt":1700000000000,"access":["calendar.read","gmail.send"],"needsReconnect":false}"#

final class GoogleIntegrationsTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> GoogleIntegrationsClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        return GoogleIntegrationsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: configuration), accessToken: { token })
    }
    func testAccountsDecodeMetadataOnlyWithAuthentication() async throws {
        ProductivityStub.route("GET /api/google-accounts", 200, #"{"accounts":[\#(googleAccountJSON)]}"#)
        let accounts = try await client().accounts()
        XCTAssertEqual(accounts.first?.displayName, "Work")
        XCTAssertEqual(accounts.first?.access, [.calendarRead, .mailSend])
        XCTAssertEqual(accounts.first?.createdAt, Date(timeIntervalSince1970: 1700000000))
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testRenameTrimsAndResetUsesExplicitNull() async throws {
        ProductivityStub.route("PATCH /api/google-accounts/\(googleAccountID)", 200, #"{"account":\#(googleAccountJSON)}"#)
        _ = try await client().rename(id: googleAccountID, name: " Work ")
        XCTAssertEqual(ProductivityStub.last?.body?["customName"] as? String, "Work")
        _ = try await client().rename(id: googleAccountID, name: nil)
        XCTAssertTrue(ProductivityStub.last?.body?["customName"] is NSNull)
    }
    func testInvalidRenameAndMissingAuthMakeNoRequests() async {
        do { _ = try await client().rename(id: googleAccountID, name: "  "); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        do { _ = try await client(token: nil).accounts(); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testRenameUsesServerUTF16LengthLimit() async {
        do { _ = try await client().rename(id: googleAccountID, name: String(repeating: "🙂", count: 31)); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testSelectAndDisconnectUseExistingRoutesAndRefusalsThrow() async throws {
        ProductivityStub.route("POST /api/google-accounts/\(googleAccountID)/select", 200, #"{"account":\#(googleAccountJSON)}"#)
        try await client().select(id: googleAccountID)
        XCTAssertEqual(ProductivityStub.last?.method, "POST")
        ProductivityStub.route("DELETE /api/google-accounts/\(googleAccountID)", 403, #"{"error":{"code":"reconnect_required"}}"#)
        do { try await client().disconnect(id: googleAccountID); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .forbidden) }
    }
    func testCalendarPaginationPreservesSelectedIDsOutsidePageAndEscapesToken() async throws {
        ProductivityStub.route("GET /api/google-accounts/\(googleAccountID)/calendars", 200, #"{"calendars":[{"id":"c1","title":"Family","time_zone":"UTC","selected":false,"selectable":true,"read_only":true}],"selected_calendar_ids":["outside-page"],"next_page_token":"next"}"#)
        let page = try await client().calendars(id: googleAccountID, pageToken: "a+b&c")
        XCTAssertEqual(page.selectedCalendarIDs, ["outside-page"])
        XCTAssertEqual(page.nextPageToken, "next")
        XCTAssertEqual(ProductivityStub.last?.query, "pageToken=a%2Bb%26c")
    }
    func testCalendarSaveUsesExplicitEmptyArrayAndRejectsOverLimit() async throws {
        ProductivityStub.route("PUT /api/google-accounts/\(googleAccountID)/calendars/selection", 200, "{}")
        try await client().saveCalendars(id: googleAccountID, calendarIDs: [])
        XCTAssertEqual(ProductivityStub.last?.body?["calendarIds"] as? [String], [])
        do { try await client().saveCalendars(id: googleAccountID, calendarIDs: ["1","2","3","4","5","6"]); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertEqual(ProductivityStub.all.count, 1)
    }
}

@MainActor final class GoogleIntegrationsStateTests: XCTestCase {
    func testOldListCannotOverwriteSuccessfulRename() async throws {
        let service = GoogleLifecycleService()
        let model = GoogleAccountsModel(service: service)
        await model.refresh()
        let account = try XCTUnwrap(model.accounts.first)
        await service.holdNextRead()
        let oldRead = Task { await model.refresh() }
        await service.waitForRead()
        let renamed = await model.rename(account, name: "New name")
        XCTAssertTrue(renamed)
        await service.releaseRead()
        await oldRead.value
        XCTAssertEqual(model.accounts.first?.displayName, "New name")
    }
    func testDisconnectFailureKeepsAccountAndOffersRetry() async {
        let service = GoogleLifecycleService()
        let model = GoogleAccountsModel(service: service)
        await model.refresh()
        guard let account = model.accounts.first else { XCTFail(); return }
        let removed = await model.remove(account)
        XCTAssertFalse(removed)
        XCTAssertEqual(model.accounts.count, 1)
        XCTAssertEqual(model.error, .offline)
        XCTAssertFalse(model.busy)
    }
    func testCalendarMoreFailurePreservesUnsavedChoicesThenRetryDeduplicates() async {
        let service = GoogleLifecycleService()
        let model = GoogleCalendarsModel(accountID: googleAccountID, service: service)
        await model.load()
        model.selected.insert("local-choice")
        await model.load(more: true)
        XCTAssertEqual(model.error, .offline)
        XCTAssertTrue(model.selected.contains("local-choice"))
        XCTAssertEqual(model.next, "page2")
        await model.load(more: true)
        XCTAssertEqual(model.calendars.map(\.id), ["c1", "c2"])
        XCTAssertNil(model.next, "Repeated cursors must stop pagination")
        XCTAssertEqual(model.outsidePage, ["local-choice", "saved-outside"])
    }
    func testCalendarCancellationDoesNotShowFailure() async {
        let model = GoogleCalendarsModel(accountID: "cancelled", service: GoogleLifecycleService())
        await model.load()
        XCTAssertNil(model.error)
        XCTAssertFalse(model.loaded)
        XCTAssertFalse(model.busy)
    }
}

private actor GoogleLifecycleService: GoogleIntegrationsService {
    private var held = false
    private var pending: CheckedContinuation<[GoogleIntegrationAccount], Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var attempts = 0
    private var account: GoogleIntegrationAccount {
        GoogleIntegrationAccount(id: googleAccountID, email: "person@example.test", customName: "Old name", selected: true, createdAt: Date(timeIntervalSince1970: 0), access: [.calendarRead], needsReconnect: false)
    }
    func holdNextRead() { held = true }
    func waitForRead() async {
        if pending != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func releaseRead() { pending?.resume(returning: [account]); pending = nil }
    func accounts() async -> [GoogleIntegrationAccount] {
        if held {
            held = false
            return await withCheckedContinuation { pending = $0; waiter?.resume(); waiter = nil }
        }
        return [account]
    }
    func rename(id: String, name: String?) -> GoogleIntegrationAccount {
        GoogleIntegrationAccount(id: id, email: account.email, customName: name, selected: true, createdAt: account.createdAt, access: account.access, needsReconnect: false)
    }
    func select(id: String) {}
    func disconnect(id: String) throws { throw ApiError.offline }
    func calendars(id: String, pageToken: String?) throws -> GoogleCalendarPage {
        if id == "cancelled" { throw ApiError.cancelled }
        if pageToken != nil {
            attempts += 1
            if attempts == 1 { throw ApiError.offline }
        }
        let rows = pageToken == nil ? #"[{"id":"c1","title":"One","time_zone":null,"selected":false,"selectable":true,"read_only":true}]"# : #"[{"id":"c1","title":"One again","time_zone":null,"selected":false,"selectable":true,"read_only":true},{"id":"c2","title":"Two","time_zone":null,"selected":false,"selectable":true,"read_only":true}]"#
        return try JSONDecoder().decode(GoogleCalendarPage.self, from: Data(#"{"calendars":\#(rows),"selected_calendar_ids":["saved-outside"],"next_page_token":"page2"}"#.utf8))
    }
    func saveCalendars(id: String, calendarIDs: [String]) {}
}
