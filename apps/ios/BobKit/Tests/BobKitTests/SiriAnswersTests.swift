import XCTest
@testable import BobKit

private final class SiriChatStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = ""
    nonisolated(unsafe) static var failure: URLError.Code?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        if let failure = Self.failure {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class SiriAnswersTests: XCTestCase {
    private func stream(_ events: [ChatStreamEvent], failing error: Error? = nil) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            events.forEach { continuation.yield($0) }
            continuation.finish(throwing: error)
        }
    }

    private func client() -> ChatClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SiriChatStub.self]
        return ChatClient(baseURL: URL(string: "https://bob.test")!, session: URLSession(configuration: configuration), accessToken: { "token" })
    }

    private func failure(of events: AsyncThrowingStream<ChatStreamEvent, Error>, timeout: Duration = .seconds(5)) async -> Error? {
        do {
            _ = try await SiriAsk.answer(question: "Hi", events: events, timeout: timeout)
            return nil
        } catch {
            return error
        }
    }

    func testFullReplyThroughTheChatClient() async throws {
        SiriChatStub.failure = nil
        SiriChatStub.status = 200
        SiriChatStub.body = [
            #"data: {"type":"start","messageId":"m1"}"#,
            #"data: {"type":"text-start","id":"t"}"#,
            #"data: {"type":"text-delta","id":"t","delta":"Sure **thing**. "}"#,
            #"data: {"type":"text-delta","id":"t","delta":"Have a good one!"}"#,
            #"data: {"type":"finish"}"#,
            "data: [DONE]"
        ].map { $0 + "\n\n" }.joined()
        let reply = try await SiriAsk.answer(question: "Hi", events: client().send(text: "Hi", messageID: "m", origin: .voice))
        XCTAssertEqual(reply.full, "Sure thing. Have a good one!")
        XCTAssertEqual(reply.spoken, "Sure thing. Have a good one!")
    }

    func testSignedOutServerGivesTheSignInLine() async {
        SiriChatStub.failure = nil
        SiriChatStub.status = 401
        SiriChatStub.body = #"{"error":{"code":"invalid_token"}}"#
        let error = await failure(of: client().send(text: "Hi", messageID: "m"))
        XCTAssertEqual(error.map(SiriLines.failure), "Open Bob and sign in first.")
    }

    func testNoTokenGivesTheSignInLine() async {
        let signedOut = ChatClient(baseURL: URL(string: "https://bob.test")!, accessToken: { nil })
        let error = await failure(of: signedOut.send(text: "Hi", messageID: "m"))
        XCTAssertEqual(error.map(SiriLines.failure), SiriLines.signedOut)
    }

    func testNoNetworkIsFriendly() async {
        SiriChatStub.failure = .notConnectedToInternet
        let error = await failure(of: client().send(text: "Hi", messageID: "m"))
        SiriChatStub.failure = nil
        XCTAssertEqual(error.map(SiriLines.failure), SiriLines.offline)
    }

    func testStreamErrorNeverCarriesProviderText() async {
        SiriChatStub.failure = nil
        SiriChatStub.status = 200
        SiriChatStub.body = #"data: {"type":"error","errorText":"gateway exploded: key sk-123"}"# + "\n\n"
        let error = await failure(of: client().send(text: "Hi", messageID: "m"))
        let line = error.map(SiriLines.failure) ?? ""
        XCTAssertEqual(line, "Bob had trouble. Try again.")
        XCTAssertFalse(line.contains("gateway"))
    }

    func testAPartialReplyThatFailsIsAFailure() async {
        let error = await failure(of: stream([.textDelta(id: "t", delta: "Half a"), .error(.upstream)]))
        XCTAssertEqual(error as? ApiError, .upstream)
    }

    func testAStoppedReplyIsAFailure() async {
        let error = await failure(of: stream([.textDelta(id: "t", delta: "Half"), .abort]))
        XCTAssertEqual(error as? ApiError, .upstream)
    }

    func testAReplyWithNoWordsPointsAtTheChat() async {
        let error = await failure(of: stream([.toolInputStart(toolCallID: "c", toolName: "x"), .finish(conversationID: nil, title: nil)]))
        XCTAssertEqual(error as? SiriFailure, .nothingToSay)
    }

    func testASlowReplyStopsWaitingAndEndsTheStream() async {
        let ended = expectation(description: "stream ended")
        let events = AsyncThrowingStream<ChatStreamEvent, Error> { continuation in
            continuation.onTermination = { _ in ended.fulfill() }
        }
        let error = await failure(of: events, timeout: .milliseconds(20))
        XCTAssertEqual(error as? SiriFailure, .stillThinking)
        await fulfillment(of: [ended], timeout: 2)
    }

    func testLongReplyIsSpokenInWholeSentences() {
        let sentence = String(repeating: "word ", count: 30).trimmingCharacters(in: .whitespaces) + "."
        let reply = SiriReply(reply: "\(sentence) \(sentence) \(sentence)")
        XCTAssertEqual(reply.full, "\(sentence) \(sentence) \(sentence)")
        XCTAssertEqual(reply.spoken, "\(sentence) The rest is in your chat with Bob.")
    }

    func testOneHugeSentenceIsCutAtAWord() {
        let reply = SiriReply(reply: String(repeating: "word ", count: 200))
        XCTAssertTrue(reply.spoken.hasSuffix("word The rest is in your chat with Bob."))
        XCTAssertLessThan(reply.spoken.count, SiriReply.spokenLimit + 40)
    }

    func testMarkdownIsGoneFromASpokenReply() {
        let reply = SiriReply(reply: "## Plan\n\n- **Walk** the [dog](https://x.test).")
        XCTAssertEqual(reply.spoken, "Plan Walk the dog.")
    }

    func testFailureLinesHideEverythingElse() {
        XCTAssertEqual(SiriLines.failure(ApiError.unauthenticated), "Open Bob and sign in first.")
        XCTAssertEqual(SiriLines.failure(ApiError.outOfCredit), "Bob is out of credit right now.")
        XCTAssertEqual(SiriLines.failure(URLError(.badURL)), "Something went wrong. Try again.")
        XCTAssertTrue(SiriLines.isCancelled(CancellationError()))
        XCTAssertTrue(SiriLines.isCancelled(ApiError.cancelled))
    }

    func testDraftTitleIsTrimmedAndBounded() throws {
        XCTAssertEqual(try SiriDrafts.title("  Buy milk \n"), "Buy milk")
        XCTAssertThrowsError(try SiriDrafts.title("  ")) { XCTAssertEqual($0 as? SiriFailure, .nothingGiven) }
        XCTAssertEqual(try SiriDrafts.title(String(repeating: "😀", count: 150)).utf16.count, 200)
    }

    func testTaskDueIsADayNotAnInstant() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(SiriDrafts.taskDue(date, zone: "UTC"), .date("2027-01-15"))
        XCTAssertNil(SiriDrafts.taskDue(nil, zone: "UTC"))
    }

    func testShortNoteIsAllTitle() throws {
        let note = try SiriDrafts.note(" Gate code is in the blue book ")
        XCTAssertEqual(note.title, "Gate code is in the blue book")
        XCTAssertEqual(note.body, "")
    }

    func testLongNoteKeepsEveryWord() throws {
        let text = String(repeating: "long words here ", count: 10).trimmingCharacters(in: .whitespaces)
        let note = try SiriDrafts.note(text)
        XCTAssertLessThanOrEqual(note.title.count, 60)
        XCTAssertTrue(text.hasPrefix(note.title))
        XCTAssertFalse(note.title.hasSuffix(" "))
        XCTAssertEqual(note.body, text)
    }

    func testNoteOfSeveralLinesTitlesFromTheFirst() throws {
        let note = try SiriDrafts.note("Trip\nPack socks")
        XCTAssertEqual(note.title, "Trip")
        XCTAssertEqual(note.body, "Trip\nPack socks")
    }

    func testEmptyNoteIsRefused() {
        XCTAssertThrowsError(try SiriDrafts.note(" \n ")) { XCTAssertEqual($0 as? SiriFailure, .nothingGiven) }
    }

    func testReminderInThePastIsRefused() throws {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertThrowsError(try SiriDrafts.reminder("Call", at: now, now: now)) { XCTAssertEqual($0 as? SiriFailure, .reminderInThePast) }
        XCTAssertEqual(try SiriDrafts.reminder("Call", at: now.addingTimeInterval(60), now: now), "Call")
    }

    func testConfirmationsAreOneShortLine() {
        XCTAssertEqual(SiriLines.taskAdded("Milk", due: nil), "Added Milk to your tasks.")
        XCTAssertEqual(SiriLines.noteSaved("Trip"), "Saved your note, Trip.")
        XCTAssertTrue(SiriLines.reminderSet("Call", at: Date(timeIntervalSince1970: 1_800_000_000), zone: "UTC", locale: Locale(identifier: "en_US")).hasPrefix("I'll remind you about Call, "))
    }

    func testOpenTasksOnly() {
        let now = Date()
        func task(_ title: String, status: TaskStatus = .open, parent: String? = nil, trashed: Date? = nil) -> TaskItem {
            TaskItem(id: title, spaceID: "s", parentTaskID: parent, title: title, status: status, orderKey: "a", createdBy: "u", trashedAt: trashed, createdAt: now, updatedAt: now)
        }
        let tasks = [task("Open"), task("Done", status: .completed), task("Item", parent: "Open"), task("Gone", trashed: now), task("Next")]
        XCTAssertEqual(SiriTasks.openTitles(tasks), ["Open", "Next"])
    }

    func testOpenTaskLines() {
        XCTAssertEqual(SiriLines.openTasks([]), "No open tasks. Nice.")
        XCTAssertEqual(SiriLines.openTasks(["A"]), "One open task: A.")
        XCTAssertEqual(SiriLines.openTasks(["A", "B"]), "Two open tasks: A and B.")
        XCTAssertEqual(SiriLines.openTasks(["A", "B", "C"]), "3 open tasks, starting with A and B.")
    }

    // MARK: Today

    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func at(_ day: Int, _ hour: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
    }

    private func brief(_ page: AgendaPage, tasks: [String] = [], hour: Int = 9) -> TodayBrief {
        TodayBrief(page: page, tasks: tasks, now: at(20, hour), calendar: calendar, locale: locale)
    }

    func testEmptyDayIsHonest() {
        let today = brief(AgendaPage(items: []))
        XCTAssertEqual(today.spoken, "Nothing planned today and no open tasks. Enjoy the room to breathe.")
        XCTAssertEqual(today.text, "Today\nNothing planned.\n\nOpen tasks\nNone.")
    }

    func testBusyDayIsBrief() {
        let items = [10, 11, 12, 13, 14].map { AgendaItem(eventID: "e\($0)", title: "E\($0)", startAt: at(20, $0)) }
        let today = brief(AgendaPage(items: items), tasks: ["A", "B", "C"])
        XCTAssertEqual(today.spoken, "Today you have E10 at 10:00 AM, E11 at 11:00 AM, E12 at 12:00 PM and 2 more. 3 open tasks, starting with A and B.")
        XCTAssertTrue(today.text.contains("2:00 PM: E14"))
        XCTAssertTrue(today.text.hasSuffix("Open tasks\nA\nB\nC"))
    }

    func testOtherDaysAreLeftOut() {
        let items = [AgendaItem(eventID: "y", title: "Yesterday", startAt: at(19, 10)), AgendaItem(eventID: "t", title: "Tomorrow", startAt: at(21, 10))]
        XCTAssertEqual(brief(AgendaPage(items: items), tasks: ["A"]).spoken, "Nothing on your calendar today. One open task: A.")
    }

    func testFinishedDayIsSaidSo() {
        let items = [AgendaItem(eventID: "e", title: "Early", startAt: at(20, 8))]
        XCTAssertEqual(brief(AgendaPage(items: items), hour: 20).spoken, "That's everything on your calendar for today. No open tasks. Nice.")
    }

    func testAllDayAndMultiDayCount() {
        let items = [
            AgendaItem(eventID: "t", title: "Timed", startAt: at(20, 15)),
            AgendaItem(eventID: "a", title: "Trip", isAllDay: true, startAt: at(19, 0), endAt: at(22, 0))
        ]
        XCTAssertEqual(brief(AgendaPage(items: items)).spoken, "Today you have Trip, all day and Timed at 3:00 PM. No open tasks. Nice.")
    }

    func testGoogleEventsCountAndGapsAreAdmitted() {
        let fetched = at(20, 0)
        let google = [
            GoogleAgendaItem(sourceKey: "1", title: "Standup", startAt: at(20, 10), endAt: at(20, 11), fetchedAt: fetched),
            GoogleAgendaItem(sourceKey: "2", title: "Holiday", startDate: "2026-10-20", endDate: "2026-10-21", fetchedAt: fetched),
            GoogleAgendaItem(sourceKey: "3", title: "Later", startDate: "2026-10-21", endDate: "2026-10-22", fetchedAt: fetched)
        ]
        let today = brief(AgendaPage(items: [], googleItems: google, googleNotice: .incomplete))
        XCTAssertEqual(today.spoken, "Today you have Holiday, all day and Standup at 10:00 AM. I couldn't read all of your Google Calendar. No open tasks. Nice.")
    }

    func testGapInGoogleStopsTheEmptyAnswer() {
        XCTAssertEqual(brief(AgendaPage(items: [], googleNotice: .reconnect)).spoken, "Nothing on your calendar today. I couldn't read all of your Google Calendar. No open tasks. Nice.")
    }

    // MARK: Shell

    func testGoingSomewhereClearsWhatIsOnTop() {
        var state = ShellState()
        state.toggleChat()
        state.present(.voice)
        state.go(to: .tasks)
        XCTAssertEqual(state.selectedTab, .spaces)
        XCTAssertFalse(state.isChatOpen)
        XCTAssertNil(state.moment)
    }

    func testChatAndVoiceOpenOverTheCurrentTab() {
        var state = ShellState()
        state.select(.today)
        state.go(to: .voice)
        XCTAssertEqual(state.selectedTab, .today)
        XCTAssertTrue(state.isChatOpen)
    }

    func testEveryDestinationHasItsTab() {
        XCTAssertEqual(ShellDestination.memory.tab, .spaces)
        XCTAssertEqual(ShellDestination.devices.tab, .you)
        XCTAssertEqual(ShellDestination.today.tab, .today)
        XCTAssertNil(ShellDestination.chat.tab)
    }
}
