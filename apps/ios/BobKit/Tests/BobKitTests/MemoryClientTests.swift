import XCTest
@testable import BobKit

private let base = URL(string: "https://api.example.test")!
private let memoryID = "mem_1"
private let spaceID = "11111111-1111-4111-8111-111111111111"
private let taskID = "22222222-2222-4222-8222-222222222222"
private let userID = "44444444-4444-4444-8444-444444444444"

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from toMemorySummary in apps/api/src/memory/http.ts.
private func memoryJSON(id: String = memoryID, kind: String = "fact", content: String = "User is vegetarian.", superseded: String = "null") -> String {
    #"{"id":"\#(id)","kind":"\#(kind)","content":"\#(content)","confidence":0.4,"sensitive":true,"source":{"conversation_id":"c1","message_id":null,"surface":"device"},"superseded_by":\#(superseded),"created_at":1700000000000,"updated_at":1700000001000}"#
}

// Copied from ActionItemSummarySchema in apps/api/src/tasks/schemas.ts.
private func actionItemJSON(status: String = "open") -> String {
    #"{"id":"ai_1","memory_id":"\#(memoryID)","content":"Call the school","confidence":0.9,"status":"\#(status)","due_at":1800000000000,"created_at":1700000000000,"updated_at":1700000000000}"#
}

final class MemoryClientTests: XCTestCase {
    private let client = MemoryClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testDefaultSessionNeverWritesToDisk() {
        XCTAssertNil(MemoryClient.memoryOnlySession.configuration.urlCache)
    }

    func testListDecodesAMemoryAndItsCursor() async throws {
        ProductivityStub.route("GET /api/memories", 200, #"{"memories":[\#(memoryJSON())],"next_cursor":"next"}"#)
        let page = try await client.memories()
        XCTAssertEqual(ProductivityStub.last?.path, "/api/memories")
        XCTAssertNil(ProductivityStub.last?.query)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(page.nextCursor, "next")
        let memory = try XCTUnwrap(page.memories.first)
        XCTAssertEqual(memory.kind, .fact)
        XCTAssertEqual(memory.content, "User is vegetarian.")
        XCTAssertTrue(memory.sensitive)
        XCTAssertEqual(memory.source.conversationID, "c1")
        XCTAssertEqual(memory.source.surface, "device")
        XCTAssertEqual(memory.createdAt, Date(timeIntervalSince1970: 1_700_000_000))
    }

    func testListSendsEveryFilter() async throws {
        ProductivityStub.route("GET /api/memories", 200, #"{"memories":[],"next_cursor":null}"#)
        _ = try await client.memories(MemoryQuery(text: " tea+milk ", cursor: "c", kind: .actionItem, sensitive: false, currentOnly: true, limit: 10))
        let query = try XCTUnwrap(ProductivityStub.last?.query)
        XCTAssertEqual(query, "limit=10&cursor=c&kind=action_item&sensitive=false&current_only=true&q=tea%2Bmilk")
    }

    func testCreateAndCorrect() async throws {
        ProductivityStub.route("POST /api/memories", 201, memoryJSON())
        _ = try await client.create(content: "I like tea", kind: .preference)
        XCTAssertEqual(ProductivityStub.last?.body?["content"] as? String, "I like tea")
        XCTAssertEqual(ProductivityStub.last?.body?["kind"] as? String, "preference")

        ProductivityStub.route("PATCH /api/memories/\(memoryID)", 200, memoryJSON(content: "User likes tea."))
        let updated = try await client.correct(id: memoryID, content: "User likes tea.")
        XCTAssertEqual(updated.content, "User likes tea.")
        XCTAssertEqual(ProductivityStub.last?.body?["content"] as? String, "User likes tea.")
        XCTAssertNil(ProductivityStub.last?.body?["kind"])
    }

    func testForgetOneAndAll() async throws {
        ProductivityStub.route("DELETE /api/memories/\(memoryID)", 204, "")
        try await client.forget(id: memoryID)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/memories/\(memoryID)")

        ProductivityStub.route("DELETE /api/memories", 204, "")
        try await client.forgetAll()
        XCTAssertEqual(ProductivityStub.last?.path, "/api/memories")
    }

    func testRefusedSecretAndSwitchedOffHaveTheirOwnErrors() async {
        ProductivityStub.route("POST /api/memories", 422, #"{"error":{"code":"secret_refused"}}"#)
        do {
            _ = try await client.create(content: "pin", kind: .fact)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .secretRefused)
        }
        ProductivityStub.route("GET /api/memories", 503, #"{"error":{"code":"memory_unavailable"}}"#)
        do {
            _ = try await client.memories()
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? ApiError, .memoryUnavailable)
        }
    }

    func testActionItems() async throws {
        ProductivityStub.route("GET /api/action-items", 200, #"{"action_items":[\#(actionItemJSON())]}"#)
        let items = try await client.actionItems()
        XCTAssertEqual(items.first?.memoryID, memoryID)
        XCTAssertEqual(items.first?.dueAt, Date(timeIntervalSince1970: 1_800_000_000))

        ProductivityStub.route("PATCH /api/action-items/ai_1", 200, actionItemJSON(status: "done"))
        let done = try await client.setStatus(actionItemID: "ai_1", status: .done)
        XCTAssertEqual(done.status, .done)
        XCTAssertEqual(ProductivityStub.last?.body?["status"] as? String, "done")
    }

    func testPromoteSendsSpaceTitleAndDue() async throws {
        // Copied from toTaskSummary in apps/api/src/tasks/http.ts.
        ProductivityStub.route("POST /api/memories/\(memoryID)/promote", 201, #"{"id":"\#(taskID)","space_id":"\#(spaceID)","parent_task_id":null,"title":"Call","body":null,"status":"open","assignee_user_id":null,"due":null,"order_key":"a0","revision":1,"created_by":"\#(userID)","completed_at":null,"completed_by":null,"trashed_at":null,"created_at":1700000000000,"updated_at":1700000001000}"#)
        let task = try await client.promote(memoryID: memoryID, spaceID: spaceID, title: "Call", dueAt: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(task.id, taskID)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["space_id"] as? String, spaceID)
        XCTAssertEqual(body["title"] as? String, "Call")
        XCTAssertEqual((body["due_at"] as? NSNumber)?.int64Value, 1_800_000_000_000)
    }

    func testPromoteWithoutADueLeavesItOut() async throws {
        ProductivityStub.route("POST /api/memories/\(memoryID)/promote", 404, #"{"error":{"code":"not_found"}}"#)
        do {
            _ = try await client.promote(memoryID: memoryID, spaceID: spaceID, title: "Call", dueAt: nil)
            XCTFail("expected not found")
        } catch {
            XCTAssertEqual(error as? ApiError, .notFound)
        }
        XCTAssertNil(ProductivityStub.last?.body?["due_at"])
    }
}

final class MemoryVoiceTests: XCTestCase {
    // The same cases as memory-voice.test.ts.
    func testStoredVoiceReadsAsYou() {
        XCTAssertEqual(MemoryVoice.forReader("User is vegetarian."), "You're vegetarian.")
        XCTAssertEqual(MemoryVoice.forReader("User's wife is Sam Example."), "Your wife is Sam Example.")
        XCTAssertEqual(MemoryVoice.forReader("User has two cats."), "You have two cats.")
        XCTAssertEqual(MemoryVoice.forReader("User prefers tea."), "You prefer tea.")
        XCTAssertEqual(MemoryVoice.forReader("User watches films."), "You watch films.")
        XCTAssertEqual(MemoryVoice.forReader("User studies law."), "You study law.")
        XCTAssertEqual(MemoryVoice.forReader("I am tall"), "You're tall")
        XCTAssertEqual(MemoryVoice.forReader("my dog is Rex"), "Your dog is Rex")
        XCTAssertEqual(MemoryVoice.forReader("Sam met User's mother and User."), "Sam met your mother and you.")
        XCTAssertEqual(MemoryVoice.forReader("The user manual is lost"), "The user manual is lost")
    }

    func testAnEditGoesBackToTheStoredVoice() {
        XCTAssertEqual(MemoryVoice.forStorage("You're vegetarian."), "User is vegetarian.")
        XCTAssertEqual(MemoryVoice.forStorage("Your wife is Sam."), "User's wife is Sam.")
        XCTAssertEqual(MemoryVoice.forStorage("You have two cats."), "User has two cats.")
        XCTAssertEqual(MemoryVoice.forStorage("You like tea."), "User likes tea.")
        XCTAssertEqual(MemoryVoice.forStorage("You whistle."), "You whistle.")
        XCTAssertEqual(MemoryVoice.forStorage("Tea is nice."), "Tea is nice.")
    }

    func testPeopleWords() {
        XCTAssertTrue(MemoryVoice.isAboutPeople("User's Wife is Sam."))
        XCTAssertFalse(MemoryVoice.isAboutPeople("User is a sonar expert."))
    }
}

final class MemoryRulesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func memory(_ id: String, _ kind: Memory.Kind, _ content: String, superseded: String? = nil, confidence: Double = 1, sensitive: Bool = false) -> Memory {
        Memory(id: id, kind: kind, content: content, confidence: confidence, sensitive: sensitive, supersededBy: superseded, createdAt: now, updatedAt: now)
    }

    func testTabsGroupCurrentFactsAndPreferencesOnly() {
        let memories = [
            memory("wife", .fact, "User's wife is Sam."),
            memory("veg", .fact, "User is vegetarian."),
            memory("tea", .preference, "User prefers tea."),
            memory("todo", .actionItem, "Call"),
            memory("plan", .intent, "Move house"),
            memory("old", .fact, "User is a vegan.", superseded: "veg")
        ]
        let all = MemoryRules.groups(memories, tab: .all)
        XCTAssertEqual(all.map(\.title), ["People, 1", "Preferences, 1", "Facts, 1"])
        XCTAssertEqual(MemoryRules.groups(memories, tab: .facts).first?.rows.map(\.id), ["veg"])
        XCTAssertEqual(MemoryRules.groups(memories, tab: .people).first?.rows.map(\.id), ["wife"])
        XCTAssertEqual(MemoryRules.older(memories).map(\.id), ["old"])
    }

    func testSublineNamesKindAndDoubt() {
        let subline = MemoryRules.subline(memory("a", .preference, "x", confidence: 0.5, sensitive: true), now: now, locale: Locale(identifier: "en_US"))
        XCTAssertTrue(subline.hasPrefix("Preference · "))
        XCTAssertTrue(subline.hasSuffix(" · Not sure · Sensitive"))
        XCTAssertFalse(MemoryRules.subline(memory("b", .fact, "x"), now: now).contains("Not sure"))
    }

    func testTaskTitleFitsTheServersLimit() {
        let item = ActionItem(id: "a", memoryID: "m", content: "  " + String(repeating: "x", count: 300))
        XCTAssertEqual(MemoryRules.taskTitle(item).count, 200)
    }

    func testOverdueIsOpenAndPastDue() {
        XCTAssertTrue(MemoryRules.isOverdue(ActionItem(id: "a", memoryID: "m", content: "x", dueAt: now.addingTimeInterval(-1)), now: now))
        XCTAssertFalse(MemoryRules.isOverdue(ActionItem(id: "a", memoryID: "m", content: "x", status: .done, dueAt: now.addingTimeInterval(-1)), now: now))
        XCTAssertFalse(MemoryRules.isOverdue(ActionItem(id: "a", memoryID: "m", content: "x"), now: now))
    }
}
