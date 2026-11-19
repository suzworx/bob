import XCTest
@testable import BobKit

private let base = URL(string: "https://api.example.test")!

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from ConversationDetailSchema in apps/api/src/conversations/schemas.ts, with the parts the AI SDK really stores.
private let detailJSON = #"""
{"id":"c1","title":"Week plan","createdAt":1700000000000,"updatedAt":1700000005000,"messages":[
 {"id":"m1","role":"user","position":0,"origin":"web_voice","createdAt":1700000001000,"versions":[
  {"id":"v1","parts":[{"type":"text","text":"Plan my week"},{"type":"file","mediaType":"image/png","filename":"a.png","url":"data:image/png;base64,AAAA"}],"versionIndex":0,"selected":true}]},
 {"id":"m2","role":"assistant","position":1,"origin":"device","createdAt":1700000002000,"versions":[
  {"id":"v2","parts":[{"type":"text","text":"Old"}],"versionIndex":0,"selected":false},
  {"id":"v3","parts":[{"type":"step-start"},{"type":"tool-add_task","toolCallId":"t","state":"output-available","input":{"a":1},"output":[1,2]},{"type":"text","text":"Done."},{"type":"text","text":"Anything else?"}],"versionIndex":1,"selected":true}]}
]}
"""#

final class ConversationsClientTests: XCTestCase {
    private let client = ConversationsClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testDefaultSessionNeverWritesToDisk() {
        XCTAssertNil(MemoryClient.memoryOnlySession.configuration.urlCache)
    }

    func testListDecodesRowsFromTheRealPath() async throws {
        ProductivityStub.route("GET /api/conversations", 200, #"{"conversations":[{"id":"c1","title":"Week plan","createdAt":1700000000000,"updatedAt":1700000005000,"pinned":true,"archived":false}]}"#)
        let rows = try await client.list()
        XCTAssertEqual(ProductivityStub.last?.path, "/api/conversations")
        XCTAssertNil(ProductivityStub.last?.query)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.title, "Week plan")
        XCTAssertTrue(row.pinned)
        XCTAssertFalse(row.archived)
        XCTAssertEqual(row.updatedAt, Date(timeIntervalSince1970: 1_700_000_005))
    }

    func testListMissingFlagsMeansOff() async throws {
        ProductivityStub.route("GET /api/conversations", 200, #"{"conversations":[{"id":"c1","title":" ","createdAt":1,"updatedAt":2}]}"#)
        let row = try await client.list()[0]
        XCTAssertFalse(row.pinned)
        XCTAssertEqual(row.displayTitle, "Untitled chat")
    }

    func testListSendsQueryAndArchived() async throws {
        ProductivityStub.route("GET /api/conversations", 200, #"{"conversations":[]}"#)
        _ = try await client.list(query: " tea+milk ", archived: true)
        XCTAssertEqual(ProductivityStub.last?.query, "q=tea%2Bmilk&archived=1")
        _ = try await client.list(query: "  ")
        XCTAssertNil(ProductivityStub.last?.query)
    }

    func testDetailDecodesSelectedVersionAndIgnoresOtherParts() async throws {
        ProductivityStub.route("GET /api/conversations/c1", 200, detailJSON)
        let detail = try await client.conversation(id: "c1")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/conversations/c1")
        XCTAssertEqual(detail.title, "Week plan")
        XCTAssertEqual(detail.messages.count, 2)
        let person = detail.messages[0]
        XCTAssertEqual(person.role, .user)
        XCTAssertEqual(person.text, "Plan my week")
        XCTAssertEqual(person.attachments.map(\.displayName), ["a.png"])
        XCTAssertEqual(person.originNote, "spoken")
        XCTAssertEqual(person.createdAt, Date(timeIntervalSince1970: 1_700_000_001))
        let reply = detail.messages[1]
        XCTAssertEqual(reply.text, "Done.\n\nAnything else?")
        XCTAssertEqual(reply.originNote, "via your device")
    }

    func testDetailReadsToolsReasoningAndNeverTheirInput() async throws {
        ProductivityStub.route("GET /api/conversations/c2", 200, #"""
        {"id":"c2","title":"t","createdAt":1,"updatedAt":2,"messages":[{"id":"m","role":"assistant","position":0,"origin":"web_text","createdAt":3,"versions":[
         {"id":"v","parts":[{"type":"step-start"},{"type":"reasoning","text":"thinking","state":"done"},{"type":"reasoning","text":"  "},
          {"type":"tool-create_task","toolCallId":"a","state":"output-available","input":{"title":"secret"},"output":{"ok":true}},
          {"type":"dynamic-tool","toolName":"search","toolCallId":"b","state":"output-error"},
          {"type":"tool-x","toolCallId":"c","state":"output-denied"},
          {"type":"text","text":"Done"},{"type":"tool-y","toolCallId":"d","state":"input-available"}],"versionIndex":0,"selected":true}]}]}
        """#)
        let detail = try await client.conversation(id: "c2")
        XCTAssertEqual(ChatTranscript(detail: detail).messages[0].parts, [
            .reasoning("thinking", isStreaming: false),
            .tools([
                ChatToolActivity(id: "a", toolName: "create_task", status: .done),
                ChatToolActivity(id: "b", toolName: "search", status: .failed),
                ChatToolActivity(id: "c", toolName: "x", status: .denied)
            ]),
            .text("Done"),
            .tools([ChatToolActivity(id: "d", toolName: "y", status: .running)])
        ])
    }

    func testFeedbackPostsTheWebsTelemetryEvent() async throws {
        ProductivityStub.route("POST /api/telemetry", 204, "")
        let trace = String(repeating: "0f", count: 16)
        try await client.sendFeedback(traceID: trace, positive: false)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/telemetry")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(Array(body.keys), ["events"])
        let event = try XCTUnwrap((body["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(event.count, 3)
        XCTAssertEqual(event["event"] as? String, "reply_feedback")
        XCTAssertEqual(event["trace_id"] as? String, trace)
        XCTAssertEqual(event["positive"] as? Bool, false)
    }

    func testFeedbackRefusesWhatIsNotATraceID() async {
        do {
            try await client.sendFeedback(traceID: "nope", positive: true)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .invalidRequest)
        }
    }

    func testMissingConversationIsNotFound() async {
        do {
            _ = try await client.conversation(id: "gone")
            XCTFail("expected not found")
        } catch {
            XCTAssertEqual(error as? ApiError, .notFound)
        }
    }

    func testPatchesSendExactlyOneChange() async throws {
        ProductivityStub.route("PATCH /api/conversations/c1", 200, #"{"id":"c1","title":"New","updatedAt":5}"#)
        try await client.rename(id: "c1", title: "  New ")
        XCTAssertEqual(ProductivityStub.last?.method, "PATCH")
        XCTAssertEqual(ProductivityStub.last?.body?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["title"] as? String, "New")

        try await client.setPinned(id: "c1", pinned: true)
        XCTAssertEqual(ProductivityStub.last?.body?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["pinned"] as? Bool, true)

        try await client.setArchived(id: "c1", archived: false)
        XCTAssertEqual(ProductivityStub.last?.body?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["archived"] as? Bool, false)
    }

    func testRenameRefusesWhatTheServerWouldBeforeSending() async {
        for title in ["   ", String(repeating: "a", count: 201)] {
            do {
                try await client.rename(id: "c1", title: title)
                XCTFail("expected a refusal")
            } catch {
                XCTAssertEqual(error as? ApiError, .invalidRequest)
            }
        }
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }

    func testDeleteAnswers204AndTreatsGoneAsDone() async throws {
        ProductivityStub.route("DELETE /api/conversations/c1", 204, "")
        try await client.delete(id: "c1")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/conversations/c1")
        try await client.delete(id: "already-gone")
    }

    func testDeleteFromHereUsesTheMessagePathAndSurfacesARefusal() async throws {
        ProductivityStub.route("DELETE /api/conversations/c1/messages/m1", 204, "")
        try await client.deleteMessages(conversationID: "c1", from: "m1")
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/conversations/c1/messages/m1")
        try await client.deleteMessages(conversationID: "c1", from: "already-gone")

        ProductivityStub.route("DELETE /api/conversations/c1/messages/m2", 409, #"{"error":{"code":"not_user_message"}}"#)
        do {
            try await client.deleteMessages(conversationID: "c1", from: "m2")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .unknown(status: 409))
        }
    }
}

final class SearchClientTests: XCTestCase {
    private let client = SearchClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testDecodesResultsFromTheRealPath() async throws {
        // Copied from SearchResultSchema in apps/api/src/conversations/search-http.ts.
        ProductivityStub.route("GET /api/search", 200, #"{"results":[{"resource_type":"note","resource_id":"n1","space_id":"11111111-1111-4111-8111-111111111111","title":"Trip","snippet":"Pack the tent","updated_at":1700000000000,"rank":2}]}"#)
        let results = try await client.search("  tent ")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/search")
        XCTAssertEqual(ProductivityStub.last?.query, "q=tent")
        let result = try XCTUnwrap(results.first)
        XCTAssertEqual(result.kind, .note)
        XCTAssertEqual(result.resourceID, "n1")
        XCTAssertEqual(result.spaceID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(result.snippet, "Pack the tent")
        XCTAssertEqual(result.id, "note:n1")
        XCTAssertEqual(result.updatedAt, Date(timeIntervalSince1970: 1_700_000_000))
    }

    func testRepeatsTypeAndSendsLimit() async throws {
        ProductivityStub.route("GET /api/search", 200, #"{"results":[]}"#)
        _ = try await client.search("a+b", types: [.task, .thread], limit: 20)
        XCTAssertEqual(ProductivityStub.last?.query, "q=a%2Bb&type=task&type=thread&limit=20")
    }

    func testAnEmptyQueryAsksNothing() async throws {
        let results = try await client.search("   ")
        XCTAssertTrue(results.isEmpty)
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }
}

final class ConversationRulesTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    func testGroupsPinnedTodayEarlierAndDropsEmptyOnes() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let today = now.addingTimeInterval(-60)
        let old = now.addingTimeInterval(-86400 * 3)
        let rows = [
            ConversationSummary(id: "p", title: "p", createdAt: old, updatedAt: old, pinned: true),
            ConversationSummary(id: "t", title: "t", createdAt: today, updatedAt: today),
            ConversationSummary(id: "e", title: "e", createdAt: old, updatedAt: old)
        ]
        let groups = ConversationRules.groups(rows, now: now, calendar: calendar)
        XCTAssertEqual(groups.map(\.title), ["Pinned", "Today", "Earlier"])
        XCTAssertEqual(groups.map { $0.rows.map(\.id) }, [["p"], ["t"], ["e"]])
        XCTAssertEqual(ConversationRules.groups([rows[1]], now: now, calendar: calendar).map(\.title), ["Today"])
    }

    func testMarkdownMatchesTheWebExport() throws {
        let detail = try JSONDecoder.milliseconds.decode(ConversationDetail.self, from: Data(detailJSON.utf8))
        let text = ConversationRules.markdown(detail, exportedAt: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(text, "# Week plan\n\nExported from Bob on 2023-11-14.\n\n**You**\n\nPlan my week\n\n[Image: a.png]\n\n**Bob**\n\nDone.\n\nAnything else?\n")
    }

    func testSearchNeedsTwoCharacters() {
        XCTAssertFalse(SearchRules.shouldSearch(" a "))
        XCTAssertTrue(SearchRules.shouldSearch("ab"))
    }

    func testSearchGroupsFollowTheWebOrder() {
        let at = Date()
        let results = [
            SearchResult(kind: .thread, resourceID: "1", spaceID: "s", title: "", updatedAt: at),
            SearchResult(kind: .task, resourceID: "2", spaceID: "s", title: "", updatedAt: at)
        ]
        XCTAssertEqual(SearchRules.groups(results).map(\.kind), [.task, .thread])
        XCTAssertEqual(results[0].displayTitle, "Untitled")
    }

    func testExcerptCentresOnTheMatchOnOneLine() {
        let body = String(repeating: "x ", count: 60) + "the Tent\nis here " + String(repeating: "y ", count: 60)
        let excerpt = SearchRules.excerpt(body, around: "tent", radius: 8)
        XCTAssertTrue(excerpt.contains("Tent is"))
        XCTAssertTrue(excerpt.hasPrefix("…"))
        XCTAssertTrue(excerpt.hasSuffix("…"))
        XCTAssertFalse(excerpt.contains("\n"))
        XCTAssertEqual(SearchRules.excerpt("short", around: "tent"), "short")
        XCTAssertEqual(SearchRules.excerpt("", around: "tent"), "")
    }
}

final class ChatTurnRequestTests: XCTestCase {
    private let client = ChatClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() {
        ProductivityStub.reset()
        ProductivityStub.route("POST /api/chat", 200, "data: [DONE]\n\n")
    }

    private func send(_ text: String, turn: ChatTurn) async throws -> [String: Any] {
        for try await _ in client.send(text: text, messageID: "m9", conversationID: "c1", turn: turn) {}
        return try XCTUnwrap(ProductivityStub.last?.body)
    }

    func testANewTurnNamesNoEdit() async throws {
        let body = try await send("Hi", turn: .new)
        XCTAssertEqual(body["id"] as? String, "c1")
        XCTAssertEqual((body["message"] as? [String: Any])?["id"] as? String, "m9")
        XCTAssertNil(body["regenerate"])
        XCTAssertNil(body["editFrom"])
        XCTAssertNil(body["editFromStart"])
    }

    func testRegenerateNeedsNoWords() async throws {
        let body = try await send("", turn: .regenerate)
        XCTAssertEqual(body["regenerate"] as? Bool, true)
        XCTAssertNil(body["editFrom"])
    }

    func testEditNamesTheMessageKept() async throws {
        let body = try await send("Better", turn: .edit(after: "m2"))
        XCTAssertEqual(body["editFrom"] as? String, "m2")
        XCTAssertNil(body["regenerate"])
    }

    func testEditingTheFirstMessage() async throws {
        let body = try await send("Better", turn: .editFromStart)
        XCTAssertEqual(body["editFromStart"] as? Bool, true)
        XCTAssertNil(body["editFrom"])
    }
}

final class ChatTranscriptHistoryTests: XCTestCase {
    private func detail() throws -> ConversationDetail {
        try JSONDecoder.milliseconds.decode(ConversationDetail.self, from: Data(detailJSON.utf8))
    }

    func testRestoringShowsStoredMessages() throws {
        let transcript = ChatTranscript(detail: try detail())
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "Week plan")
        XCTAssertEqual(transcript.messages.map(\.role), [.person, .bob])
        XCTAssertEqual(transcript.messages[0].attachments.map(\.displayName), ["a.png"])
        XCTAssertEqual(transcript.messages[0].originNote, "spoken")
        XCTAssertTrue(transcript.messages.allSatisfy(\.isStored))
        XCTAssertFalse(transcript.isStreaming)
        XCTAssertEqual(transcript.storableReplyCount, 1)
    }

    func testAPastChatCanBeContinued() throws {
        var transcript = ChatTranscript(detail: try detail())
        transcript.beginTurn(userMessageID: "p", replyMessageID: "b", text: "More")
        XCTAssertTrue(transcript.isStreaming)
        transcript.apply(.messageStart(messageID: "b", conversationID: "other", title: "Other"))
        XCTAssertEqual(transcript.conversationID, "c1")
        XCTAssertEqual(transcript.title, "Week plan")
    }

    func testEditAnchorsOnTheMessageBefore() throws {
        var transcript = ChatTranscript(detail: try detail())
        XCTAssertEqual(transcript.editTurn(for: "m1"), .editFromStart)
        XCTAssertNil(transcript.editTurn(for: "m2"))
        transcript.beginTurn(userMessageID: "p", replyMessageID: "b", text: "More")
        XCTAssertNil(transcript.editTurn(for: "p"), "not while a reply streams")
        transcript.apply(.done)
        XCTAssertEqual(transcript.editTurn(for: "p"), .edit(after: "m2"))
        transcript.beginTurn(userMessageID: "q", replyMessageID: "c", text: "Again")
        transcript.apply(.done)
        XCTAssertNil(transcript.editTurn(for: "q"), "the streamed reply before it has another id on the server")
    }

    func testEditWaitsForAConversationID() {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "p", replyMessageID: "b", text: "Hi")
        transcript.apply(.done)
        XCTAssertNil(transcript.editTurn(for: "p"))
    }

    func testRemoveFromDropsTheTail() throws {
        var transcript = ChatTranscript(detail: try detail())
        transcript.removeFrom(messageID: "m1")
        XCTAssertTrue(transcript.messages.isEmpty)
        XCTAssertEqual(transcript.conversationID, "c1")
    }

    func testRegenerateReplacesTheTrailingReply() throws {
        var transcript = ChatTranscript(detail: try detail())
        transcript.beginRegenerate(replyMessageID: "new")
        XCTAssertEqual(transcript.messages.map(\.id), ["m1", "new"])
        XCTAssertTrue(transcript.isStreaming)
        XCTAssertFalse(transcript.isUnanswered)
    }

    func testAChatEndingOnThePersonIsUnanswered() throws {
        var transcript = ChatTranscript(detail: try detail())
        XCTAssertFalse(transcript.isUnanswered)
        transcript.removeFrom(messageID: "m2")
        XCTAssertTrue(transcript.isUnanswered)
        transcript.beginRegenerate(replyMessageID: "new")
        XCTAssertEqual(transcript.messages.map(\.id), ["m1", "new"])
    }

    func testRenameReplacesTheTitle() {
        var transcript = ChatTranscript(conversationID: "c")
        transcript.apply(.finish(conversationID: "c", title: "Bob's"))
        transcript.setTitle("Mine")
        XCTAssertEqual(transcript.title, "Mine")
    }
}

private extension JSONDecoder {
    static var milliseconds: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
