import XCTest
@testable import BobKit

private let insightJSON = #"{"id":"i1","routineId":null,"googleAccountId":"g1","category":"future","title":"Room for a break","summary":"Tomorrow has a little breathing room.","periodStart":1700000000000,"periodEnd":1700000600000,"generatedAt":1700000001000,"sources":[{"kind":"calendar","id":"e1","label":"Calendar","url":"https://calendar.google.com/"}],"partial":true,"messageCount":0}"#
private let entryJSON = #"{"id":"task:a","kind":"task","action":"completed","title":"Call Sam","at":1700000000000,"recordId":"a","spaceId":"s1","routineId":null,"status":null,"count":1}"#

final class InsightsTimelineTests: XCTestCase {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        return URLSession(configuration: configuration)
    }

    override func setUp() { ProductivityStub.reset() }

    func testInsightsReadCategoryWithAuthenticatedMillisecondDates() async throws {
        ProductivityStub.route("GET /api/insights", 200, #"{"insights":[\#(insightJSON)]}"#)
        let client = InsightsClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        let rows = try await client.list(category: .future)
        XCTAssertEqual(ProductivityStub.last?.query, "category=future")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(rows.first?.generatedAt, Date(timeIntervalSince1970: 1700000001))
        XCTAssertEqual(rows.first?.sources.first?.safeURL?.host, "calendar.google.com")
        XCTAssertEqual(rows.first?.partial, true)
    }

    func testSourceLinksRejectCredentialsAndUnsafeSchemes() throws {
        for unsafe in ["https://person:secret@example.test/", "http://example.test/", "javascript:alert(1)"] {
            let json = insightJSON.replacingOccurrences(of: "https://calendar.google.com/", with: unsafe)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            let insight = try decoder.decode(Insight.self, from: Data(json.utf8))
            XCTAssertNil(insight.sources.first?.safeURL)
        }
    }

    func testTimelineSendsDayZoneFilterAndWholeCursor() async throws {
        ProductivityStub.route("GET /api/timeline", 200, #"{"day":"2026-10-31","timeZone":"America/Los_Angeles","entries":[\#(entryJSON)],"nextCursor":{"before":1700000000000,"beforeId":"task:a"}}"#)
        let client = TimelineClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        let page = try await client.list(query: TimelineQuery(day: "2026-10-31", timeZone: "America/Los_Angeles", kind: .task), cursor: TimelineCursor(before: 1700000000001, beforeID: "task:+"))
        XCTAssertEqual(ProductivityStub.last?.query, "day=2026-10-31&timeZone=America/Los_Angeles&kind=task&limit=30&before=1700000000001&beforeId=task:%2B")
        XCTAssertEqual(page.entries.first?.at, Date(timeIntervalSince1970: 1700000000))
        XCTAssertEqual(page.nextCursor?.beforeID, "task:a")
    }

    func testMissingSessionMakesNoRequest() async {
        let client = InsightsClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { nil })
        do { _ = try await client.list(category: .past); XCTFail("Must require a session") }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }

    func testRoutineRecapReadsTheExistingRunRoute() async throws {
        let routineID = "11111111-1111-4111-8111-111111111111"
        let runID = "22222222-2222-4222-8222-222222222222"
        ProductivityStub.route("GET /api/routines/\(routineID)/runs/\(runID)", 200, #"{"run":{"id":"r1","status":"completed","result":{"title":"A small win","summary":"You made room.","sources":[],"partial":false}}}"#)
        let client = TimelineClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        let recap = try await client.recap(routineID: routineID, runID: runID)
        XCTAssertEqual(recap.result?.summary, "You made room.")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }

    func testFailedInsightsRequestIsNotAnEmptyList() async {
        ProductivityStub.route("GET /api/insights", 403, #"{"error":{"code":"forbidden"}}"#)
        let client = InsightsClient(baseURL: URL(string: "https://example.test")!, session: session(), accessToken: { "tok" })
        do { _ = try await client.list(category: .future); XCTFail("Must preserve the refusal") }
        catch { XCTAssertEqual(error as? ApiError, .forbidden) }
    }

    func testTimelinePaginationDeduplicatesAndStopsRepeatedCursor() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let page = try decoder.decode(TimelinePage.self, from: Data(#"{"day":"2026-10-31","timeZone":"UTC","entries":[\#(entryJSON)],"nextCursor":{"before":1700000000000,"beforeId":"task:a"}}"#.utf8))
        let merged = page.appending(page)
        XCTAssertEqual(merged.entries.count, 1)
        XCTAssertNil(merged.nextCursor)
    }
}

@MainActor final class InsightsTimelineStateTests: XCTestCase {
    func testOldCategoryResponseCannotReplaceNewCategory() async {
        let gate = InsightReadGate()
        let model = InsightsFeed { category in try await gate.read(category) }
        let old = Task { await model.refresh() }
        await gate.waitForRead()
        model.category = .past
        let latest = Task { await model.refresh() }
        await gate.waitForRead()
        await gate.finish(.past)
        await latest.value
        XCTAssertEqual(model.phase, .loaded)
        await gate.fail(.future)
        await old.value
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.category, .past)
    }

    func testCancelledReadDoesNotShowAnError() async {
        let model = InsightsFeed { _ in throw ApiError.cancelled }
        await model.refresh()
        XCTAssertNotEqual(model.phase, .failed(.cancelled))
    }

    func testChangingFilterCannotReuseThePreviousCursorBeforeReload() async throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let first = try decoder.decode(TimelinePage.self, from: Data(#"{"day":"2026-10-31","timeZone":"UTC","entries":[],"nextCursor":{"before":1700000000000,"beforeId":"task:a"}}"#.utf8))
        let reader = TimelineReadStub(first: first)
        let model = TimelineFeed(timeZone: "UTC") { query, cursor in try await reader.read(query, cursor) }
        model.date = try XCTUnwrap(WallClock.instant(day: "2026-10-31", zone: "UTC"))
        await model.refresh()
        model.kind = .conversation
        await model.more()
        let attempts = await reader.attempts
        XCTAssertEqual(attempts, 0, "A cursor belongs to the day and kind that produced it")
    }

    func testPaginationFailureKeepsLoadedRowsAndAllowsRetry() async throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let first = try decoder.decode(TimelinePage.self, from: Data(#"{"day":"2026-10-31","timeZone":"UTC","entries":[\#(entryJSON)],"nextCursor":{"before":1700000000000,"beforeId":"task:a"}}"#.utf8))
        let reader = TimelineReadStub(first: first)
        let model = TimelineFeed(timeZone: "UTC") { query, cursor in try await reader.read(query, cursor) }
        model.date = try XCTUnwrap(WallClock.instant(day: "2026-10-31", zone: "UTC"))
        await model.refresh()
        await model.more()
        XCTAssertEqual(model.page?.entries.count, 1)
        XCTAssertNotNil(model.moreError)
        XCTAssertFalse(model.moreBusy)
        await model.more()
        XCTAssertEqual(model.page?.entries.count, 1)
        XCTAssertNil(model.moreError)
        XCTAssertNil(model.page?.nextCursor)
    }
}

private actor InsightReadGate {
    var pending: [InsightCategory: CheckedContinuation<[Insight], Error>] = [:]
    var waiting: CheckedContinuation<Void, Never>?
    var reads = 0
    func read(_ category: InsightCategory) async throws -> [Insight] {
        try await withCheckedThrowingContinuation { continuation in
            pending[category] = continuation
            reads += 1
            waiting?.resume()
            waiting = nil
        }
    }
    func waitForRead() async {
        if reads > 0 { reads -= 1; return }
        await withCheckedContinuation { waiting = $0 }
        reads -= 1
    }
    func finish(_ category: InsightCategory) { pending.removeValue(forKey: category)?.resume(returning: []) }
    func fail(_ category: InsightCategory) { pending.removeValue(forKey: category)?.resume(throwing: ApiError.offline) }
}

private actor TimelineReadStub {
    let first: TimelinePage
    var attempts = 0
    init(first: TimelinePage) { self.first = first }
    func read(_ query: TimelineQuery, _ cursor: TimelineCursor?) throws -> TimelinePage {
        guard cursor != nil else { return first }
        attempts += 1
        if attempts == 1 { throw ApiError.offline }
        return TimelinePage(day: query.day, timeZone: query.timeZone, entries: [], nextCursor: nil)
    }
}
