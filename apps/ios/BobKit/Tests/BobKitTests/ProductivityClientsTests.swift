import XCTest
@testable import BobKit

// Replies per "METHOD /path", and every request as it arrived, body included.
final class ProductivityStub: URLProtocol, @unchecked Sendable {
    struct Seen {
        let method: String
        let path: String
        let query: String?
        let auth: String?
        let body: [String: Any]?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) private static var seen: [Seen] = []

    static func reset() {
        lock.withLock {
            routes = [:]
            seen = []
        }
    }

    static func route(_ key: String, _ status: Int, _ body: String) {
        lock.withLock { routes[key] = (status, body) }
    }

    static var last: Seen? { lock.withLock { seen.last } }
    static var all: [Seen] { lock.withLock { seen } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? ""
        let data = request.httpBody ?? Self.read(request.httpBodyStream)
        let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let entry = Seen(method: method, path: url.path, query: URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery, auth: request.value(forHTTPHeaderField: "Authorization"), body: body)
        let reply = Self.lock.withLock {
            Self.seen.append(entry)
            return Self.routes["\(method) \(url.path)"] ?? (404, #"{"error":{"code":"not_found"}}"#)
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: reply.0, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func read(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private let base = URL(string: "https://api.example.test")!
private let spaceID = "11111111-1111-4111-8111-111111111111"
private let taskID = "22222222-2222-4222-8222-222222222222"
private let itemID = "33333333-3333-4333-8333-333333333333"
private let userID = "44444444-4444-4444-8444-444444444444"
private let noteID = "55555555-5555-4555-8555-555555555555"
private let reminderID = "66666666-6666-4666-8666-666666666666"

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from toTaskSummary in apps/api/src/tasks/http.ts.
private func taskJSON(id: String = taskID, parent: String? = nil, title: String = "Buy milk", due: String = "null", trashed: String = "null", status: String = "open", revision: Int = 3) -> String {
    let parentJSON = parent.map { "\"\($0)\"" } ?? "null"
    return #"{"id":"\#(id)","space_id":"\#(spaceID)","parent_task_id":\#(parentJSON),"title":"\#(title)","body":"Two pints","status":"\#(status)","assignee_user_id":null,"due":\#(due),"order_key":"a0","revision":\#(revision),"created_by":"\#(userID)","completed_at":null,"completed_by":null,"trashed_at":\#(trashed),"created_at":1700000000000,"updated_at":1700000001000}"#
}

// Copied from toNoteSummary in apps/api/src/notes/http.ts.
private func noteJSON(pinned: Bool = false, trashed: String = "null") -> String {
    #"{"id":"\#(noteID)","space_id":"\#(spaceID)","title":"Trip","body":"Pack","pinned":\#(pinned),"revision":2,"created_by":"\#(userID)","updated_by":"\#(userID)","ai_assisted":false,"trashed_at":\#(trashed),"created_at":1700000000000,"updated_at":1700000001000}"#
}

// Copied from toReminderSummary in apps/api/src/reminders/http.ts.
private func reminderJSON(rule: String = "null", status: String = "active") -> String {
    #"{"id":"\#(reminderID)","space_id":"\#(spaceID)","title":"Call","due_at":1700000000000,"due_zone":"Europe/London","rrule":\#(rule),"schedule_revision":1,"status":"\#(status)"}"#
}

private func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

final class SpacesClientTests: XCTestCase {
    private let client = SpacesClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testFindsThePrivateSpace() async throws {
        // Copied from toSpaceSummary in apps/api/src/spaces/http.ts.
        ProductivityStub.route("GET /api/spaces", 200, #"{"spaces":[{"id":"g","kind":"group","name":"Family","role":"owner","membership_revision":1,"created_at":1,"updated_at":1,"archived_at":null,"unread_count":0,"thread_count":0},{"id":"\#(spaceID)","kind":"private","name":"Personal","role":"owner","membership_revision":1,"created_at":1,"updated_at":1,"archived_at":null}]}"#)
        let space = try await client.privateSpace()
        XCTAssertEqual(space.id, spaceID)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }

    func testNoPrivateSpaceIsNotFound() async {
        ProductivityStub.route("GET /api/spaces", 200, #"{"spaces":[]}"#)
        do {
            _ = try await client.privateSpace()
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .notFound)
        }
    }

    func testMembers() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/members", 200, #"{"members":[{"user_id":"\#(userID)","role":"owner","joined_at":1,"display_name":null,"handle":null,"email":null}]}"#)
        let members = try await client.members(spaceID: spaceID)
        XCTAssertEqual(members.map(\.userID), [userID])
    }
}

final class TasksClientTests: XCTestCase {
    private let client = TasksClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListKeepsOnlyTopLevelTasksAndDecodesBothDueKinds() async throws {
        let dated = taskJSON(due: #"{"kind":"date","date":"2026-11-02"}"#)
        let timed = taskJSON(id: "t2", due: #"{"kind":"instant","at":1700000000000,"zone":"Europe/London"}"#)
        let child = taskJSON(id: "t3", parent: taskID)
        ProductivityStub.route("GET /api/spaces/\(spaceID)/tasks", 200, #"{"tasks":[\#(dated),\#(timed),\#(child)]}"#)
        let tasks = try await client.tasks(spaceID: spaceID)
        XCTAssertEqual(tasks.map(\.id), [taskID, "t2"])
        XCTAssertEqual(tasks[0].due, .date("2026-11-02"))
        XCTAssertEqual(tasks[1].due, .instant(at: date(1_700_000_000_000), zone: "Europe/London"))
        XCTAssertEqual(tasks[0].revision, 3)
        XCTAssertEqual(tasks[0].createdAt, date(1_700_000_000_000))
        XCTAssertEqual(tasks[0].body, "Two pints")
    }

    func testTrashedDropsLiveTasksAndAsksTheServerForTrash() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/tasks", 200, #"{"tasks":[\#(taskJSON()),\#(taskJSON(id: "t2", trashed: "1700000002000"))]}"#)
        let tasks = try await client.trashedTasks(spaceID: spaceID)
        XCTAssertEqual(tasks.map(\.id), ["t2"])
        XCTAssertEqual(ProductivityStub.last?.query, "trashed=true")
    }

    func testCreateSendsOnlyWhatWasGiven() async throws {
        ProductivityStub.route("POST /api/spaces/\(spaceID)/tasks", 201, taskJSON())
        _ = try await client.create(spaceID: spaceID, title: "Buy milk", due: .date("2026-11-02"))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["title"] as? String, "Buy milk")
        XCTAssertNil(body["body"])
        XCTAssertEqual(body["due"] as? [String: String], ["kind": "date", "date": "2026-11-02"])
    }

    func testUpdateSendsTheRevisionAndClearsWithNull() async throws {
        ProductivityStub.route("PATCH /api/tasks/\(taskID)", 200, taskJSON(revision: 4))
        let updated = try await client.update(id: taskID, revision: 3, changes: TaskChanges(title: "New", body: .some(nil), due: .some(nil)))
        XCTAssertEqual(updated.revision, 4)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["revision"] as? Int, 3)
        XCTAssertEqual(body["title"] as? String, "New")
        XCTAssertTrue(body["body"] is NSNull)
        XCTAssertTrue(body["due"] is NSNull)
        XCTAssertNil(body["status"])
    }

    func testInstantDueIsSentInMilliseconds() async throws {
        ProductivityStub.route("PATCH /api/tasks/\(taskID)", 200, taskJSON())
        _ = try await client.update(id: taskID, revision: 3, changes: TaskChanges(due: .some(.instant(at: date(1_700_000_000_000), zone: "UTC"))))
        let due = try XCTUnwrap(ProductivityStub.last?.body?["due"] as? [String: Any])
        XCTAssertEqual(due["kind"] as? String, "instant")
        XCTAssertEqual(due["at"] as? Int64, 1_700_000_000_000)
        XCTAssertEqual(due["zone"] as? String, "UTC")
    }

    func testCompleteIsAStatusPatch() async throws {
        ProductivityStub.route("PATCH /api/tasks/\(taskID)", 200, taskJSON(status: "completed", revision: 4))
        let task = try await client.setStatus(id: taskID, revision: 3, status: .completed)
        XCTAssertEqual(task.status, .completed)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["status"] as? String, "completed")
        XCTAssertEqual(body["revision"] as? Int, 3)
    }

    func testAStaleRevisionIsADistinctError() async {
        ProductivityStub.route("PATCH /api/tasks/\(taskID)", 409, #"{"error":{"code":"conflict","message":"stale","current_revision":7}}"#)
        do {
            _ = try await client.setStatus(id: taskID, revision: 3, status: .completed)
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? RevisionConflict, RevisionConflict(currentRevision: 7))
        }
    }

    func testAConflictWithoutARevisionIsNotARevisionConflict() async {
        ProductivityStub.route("PATCH /api/tasks/\(taskID)", 409, #"{"error":{"code":"conflict","message":"linked"}}"#)
        do {
            _ = try await client.setStatus(id: taskID, revision: 3, status: .completed)
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .unknown(status: 409))
        }
    }

    func testDeleteAnswersNothingAndRestoreDecodes() async throws {
        ProductivityStub.route("DELETE /api/tasks/\(taskID)", 204, "")
        ProductivityStub.route("POST /api/tasks/\(taskID)/restore", 200, taskJSON())
        try await client.delete(id: taskID)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        let restored = try await client.restore(id: taskID)
        XCTAssertEqual(restored.id, taskID)
        XCTAssertNil(ProductivityStub.last?.body)
    }

    func testChecklistRoutes() async throws {
        let path = "/api/tasks/\(taskID)/items"
        let item = taskJSON(id: itemID, parent: taskID, title: "Whole")
        ProductivityStub.route("GET \(path)", 200, #"{"items":[\#(item)]}"#)
        ProductivityStub.route("POST \(path)", 201, item)
        ProductivityStub.route("PATCH \(path)/\(itemID)", 200, item)
        let items = try await client.items(taskID: taskID)
        XCTAssertEqual(items.first?.parentTaskID, taskID)
        _ = try await client.addItem(taskID: taskID, title: "Whole")
        XCTAssertEqual(ProductivityStub.last?.body?["title"] as? String, "Whole")
        _ = try await client.moveItem(taskID: taskID, itemID: itemID, revision: 3, move: .before("other"))
        XCTAssertEqual(ProductivityStub.last?.body?["before_item_id"] as? String, "other")
        XCTAssertNil(ProductivityStub.last?.body?["after_item_id"])
        XCTAssertEqual(ProductivityStub.last?.body?["revision"] as? Int, 3)
        _ = try await client.moveItem(taskID: taskID, itemID: itemID, revision: 3, move: .after("other"))
        XCTAssertEqual(ProductivityStub.last?.body?["after_item_id"] as? String, "other")
    }

    func testSubscriberRoutes() async throws {
        let path = "/api/tasks/\(taskID)/subscribers"
        let row = #"{"task_id":"\#(taskID)","user_id":"\#(userID)","created_at":1700000000000}"#
        ProductivityStub.route("GET \(path)", 200, #"{"subscribers":[\#(row)]}"#)
        ProductivityStub.route("POST \(path)", 201, row)
        ProductivityStub.route("DELETE \(path)/\(userID)", 204, "")
        let subscribers = try await client.subscribers(taskID: taskID)
        XCTAssertEqual(subscribers.map(\.userID), [userID])
        try await client.addSubscriber(taskID: taskID, userID: userID)
        XCTAssertEqual(ProductivityStub.last?.body?["user_id"] as? String, userID)
        try await client.removeSubscriber(taskID: taskID, userID: userID)
        XCTAssertEqual(ProductivityStub.last?.path, "\(path)/\(userID)")
    }

    func testA401RepeatsOnceWithAFreshToken() async throws {
        ProductivityStub.route("GET /api/tasks/\(taskID)", 401, "{}")
        let client = TasksClient(baseURL: base, session: stubSession(), accessToken: { "old" }, reauthenticate: Reauthenticator(fresh: { _ in "new" }))
        _ = try? await client.task(id: taskID)
        XCTAssertEqual(ProductivityStub.all.map(\.auth), ["Bearer old", "Bearer new"])
    }

    func testOfflineIsMapped() async {
        final class Offline: URLProtocol, @unchecked Sendable {
            override class func canInit(with request: URLRequest) -> Bool { true }
            override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
            override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
            override func stopLoading() {}
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Offline.self]
        let client = TasksClient(baseURL: base, session: URLSession(configuration: configuration), accessToken: { "tok" })
        do {
            _ = try await client.tasks(spaceID: spaceID)
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .offline)
        }
    }
}

final class NotesClientTests: XCTestCase {
    private let client = NotesClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListAsksForTheTrashToo() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/notes", 200, #"{"notes":[\#(noteJSON(pinned: true))]}"#)
        let notes = try await client.notes(spaceID: spaceID)
        XCTAssertEqual(notes.first?.pinned, true)
        XCTAssertEqual(notes.first?.revision, 2)
        XCTAssertEqual(ProductivityStub.last?.query, "trashed=true")
    }

    func testSearchEncodesThePlusAndSkipsAnEmptyQuery() async throws {
        ProductivityStub.route("GET /api/spaces/\(spaceID)/notes/search", 200, #"{"notes":[\#(noteJSON())]}"#)
        let found = try await client.search(spaceID: spaceID, query: " a+b c ")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(ProductivityStub.last?.query, "q=a%2Bb%20c")
        let none = try await client.search(spaceID: spaceID, query: "   ")
        XCTAssertEqual(none, [])
        XCTAssertEqual(ProductivityStub.all.count, 1)
    }

    func testCreateLeavesOutAnEmptyBody() async throws {
        ProductivityStub.route("POST /api/spaces/\(spaceID)/notes", 201, noteJSON())
        _ = try await client.create(spaceID: spaceID, title: "Trip", body: "")
        XCTAssertNil(ProductivityStub.last?.body?["body"])
    }

    func testUpdateSendsTheRevisionAndAStaleOneIsAConflict() async throws {
        ProductivityStub.route("PATCH /api/notes/\(noteID)", 200, noteJSON())
        _ = try await client.update(id: noteID, revision: 2, title: "T", body: "B")
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["revision"] as? Int, 2)
        XCTAssertEqual(body["title"] as? String, "T")
        XCTAssertEqual(body["body"] as? String, "B")
        ProductivityStub.route("PATCH /api/notes/\(noteID)", 409, #"{"error":{"code":"conflict","message":"x","current_revision":9}}"#)
        do {
            _ = try await client.update(id: noteID, revision: 2, title: "T", body: "B")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? RevisionConflict, RevisionConflict(currentRevision: 9))
        }
    }

    func testPinIsPutAndUnpinIsDelete() async throws {
        ProductivityStub.route("PUT /api/notes/\(noteID)/pin", 200, noteJSON(pinned: true))
        ProductivityStub.route("DELETE /api/notes/\(noteID)/pin", 200, noteJSON())
        let pinned = try await client.setPinned(id: noteID, pinned: true)
        XCTAssertTrue(pinned.pinned)
        let unpinned = try await client.setPinned(id: noteID, pinned: false)
        XCTAssertFalse(unpinned.pinned)
    }

    func testDeleteRestoreAndRevisions() async throws {
        ProductivityStub.route("DELETE /api/notes/\(noteID)", 204, "")
        ProductivityStub.route("POST /api/notes/\(noteID)/restore", 200, noteJSON())
        ProductivityStub.route("GET /api/notes/\(noteID)/revisions", 200, #"{"revisions":[{"id":"r1","note_id":"\#(noteID)","revision":1,"title":"Trip","body":"","editor_user_id":"\#(userID)","ai_assisted":true,"created_at":1700000000000}]}"#)
        try await client.delete(id: noteID)
        _ = try await client.restore(id: noteID)
        let revisions = try await client.revisions(noteID: noteID)
        XCTAssertEqual(revisions.first?.aiAssisted, true)
    }
}

final class RemindersClientTests: XCTestCase {
    private let client = RemindersClient(baseURL: base, session: stubSession(), accessToken: { "tok" })
    private let due = ReminderDue(at: date(1_700_000_000_000), zone: "Europe/London")

    override func setUp() { ProductivityStub.reset() }

    func testListDecodesARule() async throws {
        let rule = #"{"freq":"hourly","interval":2,"window":{"start":"08:00","end":"22:00"}}"#
        ProductivityStub.route("GET /api/spaces/\(spaceID)/reminders", 200, #"{"reminders":[\#(reminderJSON(rule: rule)),\#(reminderJSON(status: "cancelled"))]}"#)
        let reminders = try await client.reminders(spaceID: spaceID)
        XCTAssertEqual(reminders[0].rule, ReminderRule(freq: .hourly, interval: 2, window: .init(start: "08:00", end: "22:00")))
        XCTAssertEqual(reminders[0].dueAt, date(1_700_000_000_000))
        XCTAssertEqual(reminders[1].status, .cancelled)
    }

    func testCreateSendsTheContract() async throws {
        ProductivityStub.route("POST /api/spaces/\(spaceID)/reminders", 201, #"{"reminder":\#(reminderJSON())}"#)
        let reminder = try await client.create(spaceID: spaceID, title: "Call", due: due, rule: ReminderRule(freq: .weekly, byWeekday: [1, 2]), recipients: [userID])
        XCTAssertEqual(reminder.id, reminderID)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["title"] as? String, "Call")
        XCTAssertEqual(body["due_at"] as? Int64, 1_700_000_000_000)
        XCTAssertEqual(body["due_zone"] as? String, "Europe/London")
        XCTAssertEqual(body["recipient_user_ids"] as? [String], [userID])
        let rule = try XCTUnwrap(body["rrule"] as? [String: Any])
        XCTAssertEqual(rule["freq"] as? String, "weekly")
        XCTAssertEqual(rule["byWeekday"] as? [Int], [1, 2])
        XCTAssertNil(rule["interval"])
    }

    func testUpdateSendsOnlyTheChangesAndNullForNoRule() async throws {
        ProductivityStub.route("PATCH /api/reminders/\(reminderID)", 200, #"{"reminder":\#(reminderJSON())}"#)
        _ = try await client.update(id: reminderID, changes: ReminderChanges(rule: .some(nil)))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertTrue(body["rrule"] is NSNull)
        XCTAssertNil(body["title"])
        XCTAssertNil(body["due_at"])
    }

    func testAnEmptyUpdateIsRefusedLocally() async {
        do {
            _ = try await client.update(id: reminderID, changes: ReminderChanges())
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .invalidRequest)
        }
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }

    func testCancel() async throws {
        ProductivityStub.route("POST /api/reminders/\(reminderID)/cancel", 200, #"{"reminder":\#(reminderJSON(status: "cancelled"))}"#)
        let reminder = try await client.cancel(id: reminderID)
        XCTAssertEqual(reminder.status, .cancelled)
    }

    func testSnoozeMovesAOneOffAndRefusesARepeatingOne() async throws {
        ProductivityStub.route("PATCH /api/reminders/\(reminderID)", 200, #"{"reminder":\#(reminderJSON())}"#)
        let oneOff = Reminder(id: reminderID, spaceID: spaceID, title: "Call", dueAt: due.at, dueZone: "Europe/London")
        _ = try await client.snooze(oneOff, until: date(1_700_000_600_000), fallbackZone: "UTC")
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["due_at"] as? Int64, 1_700_000_600_000)
        XCTAssertEqual(body["due_zone"] as? String, "Europe/London")
        var repeating = oneOff
        repeating.rule = ReminderRule(freq: .daily)
        do {
            _ = try await client.snooze(repeating, until: date(1_700_000_600_000), fallbackZone: "UTC")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .invalidRequest)
        }
    }

    func testOccurrenceSnooze() async throws {
        let path = "/api/reminders/\(reminderID)/occurrences/snooze"
        ProductivityStub.route("POST \(path)", 204, "")
        try await client.snoozeOccurrence(reminderID: reminderID, occurrenceID: "o1", until: date(1_700_000_600_000))
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["occurrence_id"] as? String, "o1")
        XCTAssertEqual(body["until"] as? Int64, 1_700_000_600_000)
    }

    func testPreviewCarriesTheRuleAsJSON() async throws {
        ProductivityStub.route("GET /api/reminders/preview", 200, #"{"occurrences":[{"at":1700000000000,"wall_time":"2023-11-14T22:13"}]}"#)
        let rings = try await client.preview(due: due, rule: ReminderRule(freq: .daily))
        XCTAssertEqual(rings, [ReminderOccurrencePreview(at: date(1_700_000_000_000), wallTime: "2023-11-14T22:13")])
        let query = try XCTUnwrap(ProductivityStub.last?.query)
        XCTAssertTrue(query.contains("due=1700000000000"))
        XCTAssertTrue(query.contains("zone=Europe/London"))
        XCTAssertTrue(query.contains("rrule=%7B%22freq%22:%22daily%22%7D"), query)
    }
}
