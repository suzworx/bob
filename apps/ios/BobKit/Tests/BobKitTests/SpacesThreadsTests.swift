import XCTest
@testable import BobKit

private let base = URL(string: "https://api.example.test")!
private let space = "11111111-1111-4111-8111-111111111111"
private let thread = "22222222-2222-4222-8222-222222222222"
private let user = "44444444-4444-4444-8444-444444444444"
private let message = "55555555-5555-4555-8555-555555555555"
private let token = String(repeating: "a", count: 43)

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from toSpaceSummary in apps/api/src/spaces/http.ts.
private let spaceJSON = #"{"id":"\#(space)","kind":"group","name":"Family","role":"admin","membership_revision":3,"created_at":1700000000000,"updated_at":1700000001000,"archived_at":null,"unread_count":4,"thread_count":2,"last_activity_at":1700000002000}"#
// Copied from toMemberSummary.
private let memberJSON = #"{"user_id":"\#(user)","role":"owner","joined_at":1700000000000,"display_name":"Sam","handle":"sam","email":"sam@example.test"}"#
// Copied from toInvitationSummary.
private let invitationJSON = #"{"id":"\#(message)","space_id":"\#(space)","invited_email":"a@example.test","role":"member","expires_at":1700000009000,"created_at":1700000000000}"#
// Copied from toThread in threads-http.ts.
private let threadJSON = #"{"id":"\#(thread)","space_id":"\#(space)","title":"Holiday","created_by":"\#(user)","archived_at":null,"last_sequence":7,"unread_count":2,"created_at":1700000000000,"updated_at":1700000001000}"#
// Copied from toMessage in threads-http.ts.
private func messageJSON(author: String = "\"\(user)\"", body: String = "Hi", revision: Int = 1, tombstoned: String = "null", origin: String = "web_text") -> String {
    #"{"id":"\#(message)","thread_id":"\#(thread)","space_id":"\#(space)","author_user_id":\#(author),"body":"\#(body)","reply_to_message_id":null,"sequence":7,"client_message_id":"c1","revision":\#(revision),"tombstoned_at":\#(tombstoned),"tombstoned_by":null,"created_at":1700000000000,"updated_at":1700000001000,"origin":"\#(origin)"}"#
}
// GroupChatSchema in web-schemas.
private let chatJSON = #"{"id":"\#(thread)","space_id":"\#(space)","title":"Chat","created_by":"\#(user)","role":"owner","created_at":1700000000000,"updated_at":1700000001000}"#

final class SpacesManagementTests: XCTestCase {
    private let client = SpacesClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testTheListCarriesRoleAndAggregates() async throws {
        ProductivityStub.route("GET /api/spaces", 200, #"{"spaces":[\#(spaceJSON)]}"#)
        let found = try await client.spaces()
        XCTAssertEqual(found.first?.role, .admin)
        XCTAssertEqual(found.first?.unreadCount, 4)
        XCTAssertEqual(found.first?.threadCount, 2)
        XCTAssertEqual(found.first?.lastActivityAt, Date(timeIntervalSince1970: 1_700_000_002))
        XCTAssertNil(ProductivityStub.last?.query)
        _ = try await client.spaces(archived: true)
        XCTAssertEqual(ProductivityStub.last?.query, "archived=true")
    }

    func testASpaceWithoutListFieldsStillDecodes() async throws {
        ProductivityStub.route("POST /api/spaces", 201, #"{"id":"\#(space)","kind":"pair","name":"Us","role":"owner","membership_revision":1,"created_at":1700000000000,"updated_at":1700000001000,"archived_at":null}"#)
        let made = try await client.create(name: "Us")
        XCTAssertEqual(ProductivityStub.last?.body?["name"] as? String, "Us")
        XCTAssertEqual(made.unreadCount, 0)
    }

    func testRenameRestoreAndArchive() async throws {
        ProductivityStub.route("PATCH /api/spaces/\(space)", 200, spaceJSON)
        ProductivityStub.route("DELETE /api/spaces/\(space)", 200, spaceJSON)
        _ = try await client.rename(spaceID: space, name: "Home")
        XCTAssertEqual(ProductivityStub.last?.body?["name"] as? String, "Home")
        _ = try await client.restore(spaceID: space)
        XCTAssertEqual(ProductivityStub.last?.body?["archived"] as? Bool, false)
        _ = try await client.archive(spaceID: space)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
    }

    func testMembersAndRoles() async throws {
        ProductivityStub.route("GET /api/spaces/\(space)/members", 200, #"{"members":[\#(memberJSON)]}"#)
        ProductivityStub.route("PATCH /api/spaces/\(space)/members/\(user)", 204, "")
        ProductivityStub.route("DELETE /api/spaces/\(space)/members/\(user)", 204, "")
        ProductivityStub.route("PUT /api/spaces/\(space)/owner", 200, spaceJSON)
        let member = try await client.members(spaceID: space).first
        XCTAssertEqual(member, SpaceMember(userID: user, displayName: "Sam", handle: "sam", email: "sam@example.test", role: .owner, joinedAt: Date(timeIntervalSince1970: 1_700_000_000)))
        try await client.setRole(spaceID: space, userID: user, role: .admin)
        XCTAssertEqual(ProductivityStub.last?.body?["role"] as? String, "admin")
        _ = try await client.transferOwner(spaceID: space, userID: user)
        XCTAssertEqual(ProductivityStub.last?.body?["user_id"] as? String, user)
        try await client.removeMember(spaceID: space, userID: user)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/spaces/\(space)/members/\(user)")
    }

    func testInvitations() async throws {
        ProductivityStub.route("GET /api/spaces/\(space)/invitations", 200, #"{"invitations":[\#(invitationJSON)]}"#)
        ProductivityStub.route("POST /api/spaces/\(space)/invitations", 201, #"{"invitation":\#(invitationJSON),"token":"\#(token)","email_sent":true,"account_created":false}"#)
        ProductivityStub.route("DELETE /api/invitations/\(message)", 204, "")
        let listed = try await client.invitations(spaceID: space)
        XCTAssertEqual(listed.first?.invitedEmail, "a@example.test")
        let issued = try await client.invite(spaceID: space, email: "a@example.test", role: .member)
        XCTAssertEqual(ProductivityStub.last?.body?["email"] as? String, "a@example.test")
        XCTAssertEqual(ProductivityStub.last?.body?["role"] as? String, "member")
        XCTAssertEqual(issued.token, token)
        XCTAssertTrue(issued.emailSent)
        try await client.revokeInvitation(id: message)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/invitations/\(message)")
    }

    func testAcceptingReadsARefusalInsteadOfThrowing() async throws {
        ProductivityStub.route("GET /api/invitations/\(token)", 200, #"{"preview":{"space_name":"Family","space_kind":"group","inviter_display_name":"Sam","exposes_history":true,"role":"admin","expires_at":1700000009000}}"#)
        let preview = try await client.previewInvitation(token: token)
        XCTAssertEqual(preview.spaceName, "Family")
        XCTAssertEqual(preview.role, .admin)
        ProductivityStub.route("POST /api/invitations/\(token)/accept", 200, #"{"status":"accepted"}"#)
        var outcome = try await client.acceptInvitation(token: token)
        XCTAssertTrue(outcome.isJoined)
        for (status, code, expected) in [(410, "expired", InvitationOutcome.expired), (403, "email_mismatch", .emailMismatch), (404, "not_found", .notFound)] {
            ProductivityStub.route("POST /api/invitations/\(token)/accept", status, #"{"status":"\#(code)"}"#)
            outcome = try await client.acceptInvitation(token: token)
            XCTAssertEqual(outcome, expected)
            XCTAssertFalse(outcome.isJoined)
        }
    }

    func testRefusalsKeepTheirMeaning() async {
        ProductivityStub.route("DELETE /api/spaces/\(space)/members/\(user)", 409, #"{"error":{"code":"last_owner"}}"#)
        do {
            try await client.removeMember(spaceID: space, userID: user)
            XCTFail("should refuse")
        } catch {
            XCTAssertEqual(error as? ApiError, .conflict(code: "last_owner"))
            XCTAssertEqual(ApiErrorMapper.userMessage(.conflict(code: "last_owner")), "The owner can't leave. Make someone else the owner first.")
        }
        ProductivityStub.route("PATCH /api/spaces/\(space)", 403, #"{"error":{"code":"forbidden"}}"#)
        do {
            _ = try await client.rename(spaceID: space, name: "x")
            XCTFail("should refuse")
        } catch {
            XCTAssertEqual(error as? ApiError, .forbidden)
        }
    }
}

final class ThreadsClientTests: XCTestCase {
    private let client = ThreadsClient(baseURL: base, session: stubSession(), pollDelay: .milliseconds(1), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListCreateRenameArchive() async throws {
        ProductivityStub.route("GET /api/spaces/\(space)/threads", 200, #"{"threads":[\#(threadJSON)]}"#)
        ProductivityStub.route("POST /api/spaces/\(space)/threads", 201, threadJSON)
        ProductivityStub.route("PATCH /api/threads/\(thread)", 200, threadJSON)
        ProductivityStub.route("DELETE /api/threads/\(thread)", 200, threadJSON)
        let first = try await client.threads(spaceID: space).first
        XCTAssertEqual(first?.unreadCount, 2)
        XCTAssertEqual(first?.lastSequence, 7)
        _ = try await client.create(spaceID: space, title: "Holiday")
        XCTAssertEqual(ProductivityStub.last?.body?["title"] as? String, "Holiday")
        _ = try await client.rename(threadID: thread, title: "Trip")
        XCTAssertEqual(ProductivityStub.last?.body?["title"] as? String, "Trip")
        _ = try await client.archive(threadID: thread)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
    }

    func testMessagesReadEveryPageUpToTheGuard() async throws {
        ProductivityStub.route("GET /api/threads/\(thread)/messages", 200, #"{"messages":[\#(messageJSON())],"next_cursor":"c"}"#)
        let capped = try await client.messages(threadID: thread)
        XCTAssertTrue(capped.isCapped)
        XCTAssertEqual(capped.messages.count, ThreadsClient.maxPages)
        XCTAssertEqual(ProductivityStub.all.first?.query, "limit=200")
        XCTAssertEqual(ProductivityStub.last?.query, "limit=200&cursor=c")
        ProductivityStub.route("GET /api/threads/\(thread)/messages", 200, #"{"messages":[\#(messageJSON())],"next_cursor":null}"#)
        let done = try await client.messages(threadID: thread)
        XCTAssertFalse(done.isCapped)
        XCTAssertEqual(done.messages.first?.authorUserID, user)
        XCTAssertEqual(done.messages.first?.origin, .webText)
    }

    func testPostEditDeleteRead() async throws {
        ProductivityStub.route("POST /api/threads/\(thread)/messages", 201, messageJSON())
        ProductivityStub.route("PATCH /api/messages/\(message)", 200, messageJSON(revision: 2))
        ProductivityStub.route("DELETE /api/messages/\(message)", 200, messageJSON(body: "", tombstoned: "1700000002000"))
        ProductivityStub.route("PUT /api/threads/\(thread)/read", 200, "{}")
        _ = try await client.post(threadID: thread, body: "Hi", clientMessageID: "c1")
        XCTAssertEqual(ProductivityStub.last?.body?["body"] as? String, "Hi")
        XCTAssertEqual(ProductivityStub.last?.body?["client_message_id"] as? String, "c1")
        let edited = try await client.edit(messageID: message, body: "Hello")
        XCTAssertEqual(edited.revision, 2)
        let deleted = try await client.delete(messageID: message)
        XCTAssertNotNil(deleted.tombstonedAt)
        try await client.markRead(threadID: thread)
        XCTAssertNil(ProductivityStub.last?.body)
        try await client.markRead(threadID: thread, through: 3)
        XCTAssertEqual(ProductivityStub.last?.body?["last_read_sequence"] as? Int, 3)
    }

    func testAskingBobWaitsForTheInvocation() async throws {
        ProductivityStub.route("POST /api/threads/\(thread)/invocations", 202, #"{"invocation_id":"\#(user)"}"#)
        ProductivityStub.route("GET /api/invocations/\(user)", 200, #"{"id":"\#(user)","thread_id":"\#(thread)","space_id":"\#(space)","state":"completed","result_message_id":"\#(message)","error_code":null}"#)
        let answered = try await client.askBob(threadID: thread, triggerMessageID: message)
        XCTAssertEqual(answered, .answered)
        XCTAssertEqual(ProductivityStub.all.first?.body?["trigger_message_id"] as? String, message)
        ProductivityStub.route("GET /api/invocations/\(user)", 200, #"{"id":"\#(user)","state":"failed","result_message_id":null}"#)
        let failed = try await client.askBob(threadID: thread, triggerMessageID: message)
        XCTAssertEqual(failed, .failed)
        ProductivityStub.route("GET /api/invocations/\(user)", 200, #"{"id":"\#(user)","state":"running","result_message_id":null}"#)
        let pending = try await client.askBob(threadID: thread, triggerMessageID: message)
        XCTAssertEqual(pending, .pending)
    }

    func testBobBusyIsAnOutcomeNotAFailure() async throws {
        ProductivityStub.route("POST /api/threads/\(thread)/invocations", 409, #"{"error":{"code":"conflict"}}"#)
        let busy = try await client.askBob(threadID: thread, triggerMessageID: message)
        XCTAssertEqual(busy, .busy)
    }
}

final class GroupChatsClientTests: XCTestCase {
    private let client = GroupChatsClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListGetCreate() async throws {
        ProductivityStub.route("GET /api/group-chats", 200, #"{"chats":[\#(chatJSON)]}"#)
        ProductivityStub.route("GET /api/group-chats/\(thread)", 200, #"{"chat":\#(chatJSON)}"#)
        ProductivityStub.route("POST /api/group-chats", 201, #"{"chat":\#(chatJSON)}"#)
        let listed = try await client.chats()
        XCTAssertEqual(listed.first?.spaceID, space)
        let one = try await client.chat(id: thread)
        XCTAssertEqual(one.role, .owner)
        _ = try await client.create(requestID: user)
        XCTAssertEqual(ProductivityStub.last?.body?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["request_id"] as? String, user)
        _ = try await client.create(requestID: user, sourceConversationID: "conv-12345", textOnly: true)
        XCTAssertEqual(ProductivityStub.last?.body?["source_conversation_id"] as? String, "conv-12345")
        XCTAssertEqual(ProductivityStub.last?.body?["text_only"] as? Bool, true)
    }

    func testAnUnsupportedHistoryIsARefusalThatCanBeOffered() async {
        ProductivityStub.route("POST /api/group-chats", 409, #"{"error":{"code":"unsupported_history"}}"#)
        do {
            _ = try await client.create(requestID: user, sourceConversationID: "conv-12345")
            XCTFail("should refuse")
        } catch {
            XCTAssertEqual(error as? ApiError, .conflict(code: "unsupported_history"))
        }
    }

    func testInvitationsAndLinks() async throws {
        ProductivityStub.route("GET /api/group-chats/invitations/\(token)", 200, #"{"title":"Chat","inviter_name":"Sam","expires_at":1700000009000}"#)
        ProductivityStub.route("POST /api/group-chats/invitations/\(token)/accept", 200, #"{"chat":\#(chatJSON)}"#)
        ProductivityStub.route("POST /api/group-chats/\(thread)/links", 201, #"{"token":"\#(token)","expires_at":1700000009000}"#)
        ProductivityStub.route("DELETE /api/group-chats/\(thread)/links", 204, "")
        ProductivityStub.route("POST /api/group-chats/\(thread)/invitations", 200, #"{"sent":true}"#)
        let preview = try await client.preview(token: token)
        XCTAssertEqual(preview.inviterName, "Sam")
        let joined = try await client.accept(token: token)
        XCTAssertEqual(joined.id, thread)
        let link = try await client.createLink(chatID: thread)
        XCTAssertEqual(link.token, token)
        try await client.disableLinks(chatID: thread)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        try await client.invite(chatID: thread, email: "a@example.test")
        XCTAssertEqual(ProductivityStub.last?.body?["email"] as? String, "a@example.test")
    }

    func testMembersAndLeaving() async throws {
        ProductivityStub.route("GET /api/group-chats/\(thread)/members", 200, #"{"members":[{"user_id":"\#(user)","display_name":null,"role":"owner"}]}"#)
        ProductivityStub.route("DELETE /api/group-chats/\(thread)/members/\(user)", 204, "")
        let members = try await client.members(chatID: thread)
        XCTAssertNil(members.first?.displayName)
        try await client.removeMember(chatID: thread, userID: user)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/group-chats/\(thread)/members/\(user)")
    }
}

final class SpaceWritesInOtherClientsTests: XCTestCase {
    private func session() -> URLSession { stubSession() }

    override func setUp() { ProductivityStub.reset() }

    private let taskJSON = #"{"id":"\#(thread)","space_id":"\#(space)","parent_task_id":null,"title":"T","body":null,"status":"open","assignee_user_id":"\#(user)","due":null,"order_key":"a0","revision":3,"created_by":"\#(user)","completed_at":null,"completed_by":null,"trashed_at":null,"created_at":1700000000000,"updated_at":1700000001000}"#

    func testTaskAssigneeAndMove() async throws {
        let client = TasksClient(baseURL: base, session: session(), accessToken: { "tok" })
        ProductivityStub.route("PATCH /api/tasks/\(thread)", 200, taskJSON)
        ProductivityStub.route("POST /api/spaces/\(space)/tasks", 201, taskJSON)
        _ = try await client.create(spaceID: space, title: "T", assigneeUserID: user)
        XCTAssertEqual(ProductivityStub.last?.body?["assignee_user_id"] as? String, user)
        _ = try await client.update(id: thread, revision: 3, changes: TaskChanges(assigneeUserID: .some(nil)))
        XCTAssertTrue(ProductivityStub.last?.body?["assignee_user_id"] is NSNull)
        XCTAssertEqual(ProductivityStub.last?.body?["revision"] as? Int, 3)
        _ = try await client.update(id: thread, revision: 3, changes: TaskChanges(spaceID: space))
        XCTAssertEqual(ProductivityStub.last?.body?["space_id"] as? String, space)
        XCTAssertNil(ProductivityStub.last?.body?["assignee_user_id"])
    }

    func testPublishingANoteSendsTheChosenFields() async throws {
        let client = NotesClient(baseURL: base, session: session(), accessToken: { "tok" })
        ProductivityStub.route("POST /api/notes/\(message)/publish", 201, #"{"id":"\#(user)","space_id":"\#(space)","title":"T","body":"","pinned":false,"revision":1,"created_by":"\#(user)","updated_by":"\#(user)","ai_assisted":false,"trashed_at":null,"created_at":1700000000000,"updated_at":1700000001000}"#)
        let copy = try await client.publish(noteID: message, toSpace: space, includingBody: false)
        XCTAssertEqual(copy.spaceID, space)
        XCTAssertEqual(ProductivityStub.last?.body?["space_id"] as? String, space)
        let fields = ProductivityStub.last?.body?["fields"] as? [String: Bool]
        XCTAssertEqual(fields, ["title": true, "body": false])
    }

    func testDevicePointers() async throws {
        let client = DevicesClient(baseURL: base, session: session(), accessToken: { "tok" })
        ProductivityStub.route("PUT /api/devices/active-conversation", 202, #"{"status":"pending"}"#)
        ProductivityStub.route("PUT /api/devices/active-space", 200, #"{"active_space":null}"#)
        try await client.setTalkingIn(deviceID: user, target: .thread(id: thread, spaceID: space))
        XCTAssertTrue(ProductivityStub.last?.body?["conversation_id"] is NSNull)
        XCTAssertEqual(ProductivityStub.last?.body?["thread_id"] as? String, thread)
        XCTAssertEqual(ProductivityStub.last?.body?["space_id"] as? String, space)
        XCTAssertEqual(ProductivityStub.last?.body?["device_id"] as? String, user)
        try await client.setTalkingIn(deviceID: user, target: .newConversation(spaceID: nil))
        XCTAssertTrue(ProductivityStub.last?.body?["conversation_id"] is NSNull)
        XCTAssertTrue(ProductivityStub.last?.body?["space_id"] is NSNull)
        XCTAssertNil(ProductivityStub.last?.body?["thread_id"])
        try await client.setTalkingIn(deviceID: user, target: .conversation(id: "conv-1", spaceID: nil))
        XCTAssertEqual(ProductivityStub.last?.body?["conversation_id"] as? String, "conv-1")
        try await client.setNewConversationSpace(deviceID: user, spaceID: space)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/devices/active-space")
        XCTAssertEqual(ProductivityStub.last?.body?["space_id"] as? String, space)
    }
}

final class SpaceRulesTests: XCTestCase {
    private func space(_ kind: SpaceSummary.Kind = .group, _ role: SpaceRole) -> SpaceSummary {
        SpaceSummary(id: "s", kind: kind, name: "S", role: role)
    }

    func testHeaderRulesMatchTheWeb() {
        XCTAssertTrue(SpaceRules.canRename(space(.group, .admin)))
        XCTAssertFalse(SpaceRules.canRename(space(.group, .member)))
        XCTAssertFalse(SpaceRules.canRename(space(.private, .owner)))
        XCTAssertTrue(SpaceRules.canArchive(space(.group, .owner)))
        XCTAssertFalse(SpaceRules.canArchive(space(.pair, .owner)))
        XCTAssertFalse(SpaceRules.canArchive(space(.group, .admin)))
        XCTAssertTrue(SpaceRules.canLeave(space(.group, .admin)))
        XCTAssertFalse(SpaceRules.canLeave(space(.group, .owner)))
        XCTAssertFalse(SpaceRules.canLeave(space(.private, .owner)))
    }

    func testMemberRulesMatchTheWeb() {
        let me = SpaceMember(userID: "me", role: .member)
        let other = SpaceMember(userID: "o", role: .member)
        let owner = SpaceMember(userID: "own", role: .owner)
        XCTAssertTrue(SpaceRules.canRemove(member: me, in: space(.group, .member), me: "me"))
        XCTAssertFalse(SpaceRules.canRemove(member: other, in: space(.group, .member), me: "me"))
        XCTAssertTrue(SpaceRules.canRemove(member: other, in: space(.group, .admin), me: "me"))
        XCTAssertFalse(SpaceRules.canRemove(member: owner, in: space(.group, .admin), me: "me"))
        XCTAssertTrue(SpaceRules.canChangeRole(of: other, in: space(.group, .owner), me: "me"))
        XCTAssertFalse(SpaceRules.canChangeRole(of: other, in: space(.group, .admin), me: "me"))
        XCTAssertTrue(SpaceRules.canMakeOwner(other, in: space(.group, .owner), me: "me"))
        XCTAssertFalse(SpaceRules.canMakeOwner(other, in: space(.pair, .owner), me: "me"))
        XCTAssertFalse(SpaceRules.canMakeOwner(me, in: space(.group, .owner), me: "me"))
    }

    func testArchivingAThread() {
        let thread = SpaceThread(id: "t", spaceID: "s", title: "T", createdBy: "me", createdAt: Date(), updatedAt: Date())
        XCTAssertTrue(SpaceRules.canArchive(thread: thread, in: space(.group, .member), me: "me"))
        XCTAssertFalse(SpaceRules.canArchive(thread: thread, in: space(.group, .member), me: "other"))
        XCTAssertTrue(SpaceRules.canArchive(thread: thread, in: space(.group, .admin), me: "other"))
    }

    func testEmailCheckIsTheWebs() {
        XCTAssertTrue(SpaceRules.isValidEmail(" a@b.co "))
        for bad in ["", "a", "a@b", "@b.co", "a@b.", "a b@c.d", "a@b@c.d", String(repeating: "a", count: 250) + "@b.co"] {
            XCTAssertFalse(SpaceRules.isValidEmail(bad), bad)
        }
    }

    func testAnInvitationIsReadFromALinkOrABareToken() {
        XCTAssertEqual(InvitationCode("  \(token)\n"), InvitationCode(token: token, kind: .unknown))
        XCTAssertEqual(InvitationCode("https://app.heybob.xyz/invite/\(token)"), InvitationCode(token: token, kind: .space))
        XCTAssertEqual(InvitationCode("https://app.heybob.xyz/join-chat/\(token)?x=1"), InvitationCode(token: token, kind: .groupChat))
        XCTAssertEqual(InvitationCode("/join-chat/\(token)"), InvitationCode(token: token, kind: .groupChat))
        for bad in ["", "short", "https://evil.test/a/b", String(repeating: "a", count: 42) + "/", String(repeating: "é", count: 43)] {
            XCTAssertNil(InvitationCode(bad), bad)
        }
    }

    func testOrderAndNames() {
        let older = SpaceSummary(id: "o", kind: .group, name: "O", lastActivityAt: Date(timeIntervalSince1970: 1))
        let newer = SpaceSummary(id: "n", kind: .group, name: "N", lastActivityAt: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(SpaceRules.byActivity([older, newer]).map(\.id), ["n", "o"])
        XCTAssertEqual(SpaceRules.name(displayName: " ", email: "a@b.co"), "a@b.co")
        XCTAssertEqual(SpaceRules.name(displayName: nil), "Someone")
        XCTAssertEqual(SpaceRules.initials("Sam Lee"), "SL")
        XCTAssertEqual(SpaceRules.subline(SpaceSummary(id: "p", kind: .private, name: "P")), "Just you")
        XCTAssertEqual(SpaceRules.subline(SpaceSummary(id: "g", kind: .group, name: "G", threadCount: 1)), "Group · 1 thread")
    }
}

final class DeviceTalkRulesTests: XCTestCase {
    private let family = SpaceSummary(id: "s", kind: .group, name: "Family")

    private func thread(_ id: String, at: TimeInterval, archived: Bool = false) -> SpaceThread {
        SpaceThread(id: id, spaceID: "s", title: id.uppercased(), createdBy: "u", archivedAt: archived ? Date() : nil, createdAt: Date(), updatedAt: Date(timeIntervalSince1970: at))
    }

    func testOptionsMergeNewestFirstWithoutArchived() {
        let chat = ConversationSummary(id: "c", title: "Chat", createdAt: Date(timeIntervalSince1970: 1), updatedAt: Date(timeIntervalSince1970: 2))
        let options = DeviceTalkRules.options(conversations: [chat], threads: [(family, [thread("a", at: 1), thread("b", at: 3), thread("z", at: 9, archived: true)])])
        XCTAssertEqual(options.map(\.ref), ["thr_b", "c", "thr_a"])
        XCTAssertEqual(options[0].target(defaultSpace: nil), .thread(id: "b", spaceID: "s"))
        XCTAssertEqual(options[1].target(defaultSpace: "s"), .conversation(id: "c", spaceID: "s"))
        XCTAssertEqual(DeviceTalkRules.matching(options, query: " a "), [options[1], options[2]])
    }

    func testTheRowSaysWhatItTalksIn() {
        var device = Device(id: "d", name: "D", pairedAt: Date())
        XCTAssertEqual(DeviceTalkRules.talkingIn(device, options: [], spaces: []), "A new conversation, in General")
        device.activeSpaceID = "s"
        XCTAssertEqual(DeviceTalkRules.talkingIn(device, options: [], spaces: [family]), "A new conversation, in Family")
        device.activeConversationID = "thr_t"
        let option = DeviceTalkOption(ref: "thr_t", title: "Trip", place: "Family", updatedAt: Date())
        XCTAssertEqual(DeviceTalkRules.talkingIn(device, options: [option], spaces: [family]), "Trip, in Family")
        XCTAssertEqual(DeviceTalkRules.talkingIn(device, options: [], spaces: [family]), "A conversation")
    }

    func testADeviceReadsItsPointers() throws {
        let data = Data(#"{"id":"d","name":"D","model":"M","paired_at":1700000000000,"last_seen_at":null,"connected":false,"settings":{"volume":7,"muted":false,"mode":"wake","dnd":true,"ring_seconds":45,"ring_sound":"chime","wake_word":"bob"},"pending":false,"settings_supported":true,"ring_settings_supported":true,"wake_word_supported":true,"live":{"connected":false},"active_conversation_id":"thr_t","active_space_id":"s"}"#.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let device = try decoder.decode(Device.self, from: data)
        XCTAssertEqual(device.activeConversationID, "thr_t")
        XCTAssertEqual(device.activeSpaceID, "s")
    }
}

final class RoomRulesTests: XCTestCase {
    func testOnlyARealAddressAsksBob() {
        XCTAssertTrue(RoomMentions.addressesBob("@bob hi"))
        XCTAssertTrue(RoomMentions.addressesBob("hey @BOB, please"))
        for quiet in ["hi", "me@bob.com", "\\@bob", "@bob.bob", "`@bob`", "```\n@bob\n```", "@bobs"] {
            XCTAssertFalse(RoomMentions.addressesBob(quiet), quiet)
        }
    }

    func testAloneInASpaceEveryMessageReachesBob() {
        XCTAssertTrue(RoomMentions.shouldAskBob("hi", requireMention: false, memberIDs: ["me"], me: "me"))
        XCTAssertFalse(RoomMentions.shouldAskBob("hi", requireMention: true, memberIDs: ["me"], me: "me"))
        XCTAssertFalse(RoomMentions.shouldAskBob("hi", requireMention: false, memberIDs: ["me", "o"], me: "me"))
        XCTAssertFalse(RoomMentions.shouldAskBob("hi", requireMention: false, memberIDs: [], me: nil))
        XCTAssertTrue(RoomMentions.shouldAskBob("@bob hi", requireMention: true, memberIDs: ["me", "o"], me: "me"))
    }

    func testPeopleSayBobAndTheServerReadsItsHandle() {
        XCTAssertEqual(RoomMentions.toWire("@Bob hi", handles: ["sam"]), "@bob hi")
        XCTAssertEqual(RoomMentions.toWire("hey @bob, `@bob`", handles: []), "hey @bob, `@bob`")
        XCTAssertEqual(RoomMentions.toWire("@bob hi", handles: ["bob"]), "@bob hi")
        XCTAssertEqual(RoomMentions.toWire("me@bob.com", handles: []), "me@bob.com")
        XCTAssertEqual(RoomMentions.toShown("@bob hi"), "@Bob hi")
        XCTAssertTrue(RoomMentions.addressesBob(RoomMentions.toWire("@Bob hi", handles: [])))
    }

    func testThePickerFollowsTheLastWord() {
        XCTAssertEqual(RoomMentions.activeQuery(in: "hi @sa"), "sa")
        XCTAssertEqual(RoomMentions.activeQuery(in: "@"), "")
        XCTAssertNil(RoomMentions.activeQuery(in: "hi @sa then"))
        XCTAssertNil(RoomMentions.activeQuery(in: "me@b"))
        let sam = RoomPerson(id: "s", name: "Sam Lee", handle: "sam")
        let nameless = RoomPerson(id: "n", name: "No Handle")
        XCTAssertEqual(RoomMentions.matches("", people: [sam, nameless]).map(\.name), ["Sam Lee", "Bob"])
        XCTAssertEqual(RoomMentions.matches("bo", people: [sam]).map(\.name), ["Bob"])
        XCTAssertEqual(RoomMentions.inserting(sam, into: "hi @sa"), "hi @sam ")
    }

    func testOnlyRealPeopleStandOut() {
        let segments = RoomMentions.segments("hi @sam. and @nobody, @Bob", handles: ["sam"])
        XCTAssertEqual(segments.filter(\.isMention).map(\.text), ["@sam", "@Bob"])
        XCTAssertEqual(segments.map(\.text).joined(), "hi @sam. and @nobody, @Bob")
    }

    func testAThreadBecomesTheConversationsMessages() {
        let people = [RoomPerson(id: "me", name: "Me Too", handle: "me"), RoomPerson(id: "o", name: "Sam Lee", fillIndex: 2)]
        func stored(_ author: String?, body: String = "@bob hi", revision: Int = 1, deleted: Bool = false, origin: ThreadMessage.Origin = .webText) -> ThreadMessage {
            ThreadMessage(id: UUID().uuidString, threadID: "t", spaceID: "s", authorUserID: author, body: body, sequence: 1, clientMessageID: "c", revision: revision, tombstonedAt: deleted ? Date() : nil, createdAt: Date(), updatedAt: Date(), origin: origin)
        }
        let mine = RoomTranscript.chatMessage(stored("me"), people: people, me: "me")
        XCTAssertTrue(mine.isMine)
        XCTAssertEqual(mine.text, "@Bob hi")
        let theirs = RoomTranscript.chatMessage(stored("o", revision: 2, origin: .device), people: people, me: "me")
        XCTAssertFalse(theirs.isMine)
        XCTAssertEqual(theirs.role, .person)
        XCTAssertEqual(theirs.author?.initials, "SL")
        XCTAssertEqual(theirs.author?.fillIndex, 2)
        XCTAssertTrue(theirs.isEdited)
        XCTAssertEqual(theirs.originNote, "via a device")
        let bob = RoomTranscript.chatMessage(stored(nil, body: "**Hi**"), people: people, me: "me")
        XCTAssertEqual(bob.role, .bob)
        XCTAssertEqual(bob.author?.name, "Bob")
        XCTAssertEqual(bob.parts, [.text("**Hi**")])
        let left = RoomTranscript.chatMessage(stored("gone"), people: people, me: "me")
        XCTAssertEqual(left.author?.name, "Someone")
        let deleted = RoomTranscript.chatMessage(stored("o", revision: 2, deleted: true), people: people, me: "me")
        XCTAssertTrue(deleted.isDeleted)
        XCTAssertFalse(deleted.isEdited)
        XCTAssertEqual(RoomTranscript.newestPerAuthor([mine, theirs, deleted]), [mine.id, theirs.id])
    }

    func testAPrivateMessageIsAlwaysMine() {
        XCTAssertTrue(ChatMessage(id: "p", role: .person, text: "x", state: .complete).isMine)
        XCTAssertFalse(ChatMessage(id: "b", role: .bob, text: "x", state: .complete).isMine)
    }
}
