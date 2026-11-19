import XCTest
@testable import BobKit

private let preparationAccountID = "11111111-1111-4111-8111-111111111111"
final class InsightsPreparationTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> InsightsClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return InsightsClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
    }
    func testExplicitPreparationUsesAuthenticatedSelectedAccountAndCategory() async throws {
        ProductivityStub.route("POST /api/insights/refresh", 200, #"{"insights":[]}"#)
        let rows = try await client().prepare(accountID: preparationAccountID, category: .reflections)
        XCTAssertTrue(rows.isEmpty)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(ProductivityStub.last?.body?["googleAccountId"] as? String, preparationAccountID)
        XCTAssertEqual(ProductivityStub.last?.body?["category"] as? String, "reflections")
        XCTAssertEqual(ProductivityStub.last?.body?.count, 2)
    }
    func testPastInvalidAccountAndMissingSessionNeverRunProvider() async {
        for (id, category) in [(preparationAccountID, InsightCategory.past), ("bad", .future)] {
            do { _ = try await client().prepare(accountID: id, category: category); XCTFail() }
            catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        }
        do { _ = try await client(token: nil).prepare(accountID: preparationAccountID, category: .future); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testRefusalDoesNotBecomeEmptySuccess() async {
        ProductivityStub.route("POST /api/insights/refresh", 409, #"{"error":{"code":"insight_no_selected_calendars"}}"#)
        do { _ = try await client().prepare(accountID: preparationAccountID, category: .future); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 409)) }
    }
}

@MainActor final class InsightsPreparationStateTests: XCTestCase {
    func testAccountReadNeverPreparesAndRequiresExplicitEligibleSelection() async {
        let gate = PreparationGate()
        let model = InsightsPreparation(category: .future, accounts: { await gate.accounts() }, prepare: { try await gate.prepare($0, $1) })
        await model.loadAccounts()
        XCTAssertEqual(model.eligibleAccounts.map(\.id), [preparationAccountID])
        XCTAssertNil(model.selectedAccountID)
        let blocked = await model.prepare()
        XCTAssertFalse(blocked)
        let initialCalls = await gate.callCount()
        XCTAssertEqual(initialCalls, 0)
        model.selectedAccountID = preparationAccountID
        let prepared = await model.prepare()
        XCTAssertTrue(prepared)
        XCTAssertNotNil(model.notice)
        let finalCalls = await gate.callCount()
        XCTAssertEqual(finalCalls, 1)
    }
    func testFailurePreservesSelectionForManualRetry() async {
        let gate = PreparationGate(failing: true)
        let model = InsightsPreparation(category: .reflections, accounts: { await gate.accounts() }, prepare: { try await gate.prepare($0, $1) })
        await model.loadAccounts()
        model.selectedAccountID = preparationAccountID
        let result = await model.prepare()
        XCTAssertFalse(result)
        XCTAssertEqual(model.selectedAccountID, preparationAccountID)
        XCTAssertEqual(model.error, .offline)
        XCTAssertFalse(model.busy)
        XCTAssertNil(model.notice)
    }
    func testRefreshedGrantRevocationClearsSelectedAccount() async {
        let gate = PreparationGate()
        let model = InsightsPreparation(category: .future, accounts: { await gate.accounts() }, prepare: { try await gate.prepare($0, $1) })
        await model.loadAccounts()
        model.selectedAccountID = preparationAccountID
        await gate.revoke()
        await model.loadAccounts()
        XCTAssertNil(model.selectedAccountID)
        XCTAssertFalse(model.canPrepare)
        let calls = await gate.callCount()
        XCTAssertEqual(calls, 0)
    }
    func testCancellationDiscardsCompletionAndDoesNotRetry() async {
        let gate = PreparationGate(holding: true)
        let model = InsightsPreparation(category: .future, accounts: { await gate.accounts() }, prepare: { try await gate.prepare($0, $1) })
        await model.loadAccounts()
        model.selectedAccountID = preparationAccountID
        let work = Task { await model.prepare() }
        await gate.waitForPrepare()
        let duplicate = await model.prepare()
        XCTAssertFalse(duplicate)
        XCTAssertTrue(model.busy)
        model.cancel()
        await gate.release()
        let result = await work.value
        XCTAssertFalse(result)
        XCTAssertNil(model.notice)
        let finalCalls = await gate.callCount()
        XCTAssertEqual(finalCalls, 1)
    }
}
private actor PreparationGate {
    private var calls = 0
    private var revoked = false
    private var failing: Bool
    private var holding: Bool
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    init(failing: Bool = false, holding: Bool = false) { self.failing = failing; self.holding = holding }
    func accounts() -> [GoogleIntegrationAccount] {
        if revoked { return [] }
        return [account(preparationAccountID, reconnect: false, access: [.calendarRead, .mailRead]), account("revoked", reconnect: true, access: [.calendarRead]), account("send-only", reconnect: false, access: [.mailSend])]
    }
    private func account(_ id: String, reconnect: Bool, access: [GoogleCapability]) -> GoogleIntegrationAccount {
        GoogleIntegrationAccount(id: id, email: "example@example.test", selected: true, createdAt: Date(), access: access, needsReconnect: reconnect)
    }
    func prepare(_ id: String, _ category: InsightCategory) async throws -> [Insight] {
        calls += 1
        if holding { await withCheckedContinuation { continuation = $0; waiter?.resume(); waiter = nil } }
        if failing { throw ApiError.offline }
        return []
    }
    func callCount() -> Int { calls }
    func revoke() { revoked = true }
    func waitForPrepare() async { if continuation == nil { await withCheckedContinuation { waiter = $0 } } }
    func release() { continuation?.resume(); continuation = nil }
}
