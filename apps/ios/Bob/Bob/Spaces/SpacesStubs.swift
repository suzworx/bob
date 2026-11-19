import BobKit
import Foundation

nonisolated let demoFamily = "demo-family"
nonisolated let demoBooks = "demo-books"
nonisolated let demoSam = "demo-sam"
nonisolated let demoJo = "demo-jo"
nonisolated let demoChatSpace = "demo-chat-space"
private nonisolated let demoChat = "demo-gc1"

// The demo's shared world in memory: several people, so a group conversation can be seen. Sam answers a moment after anything you post, and Bob answers when asked.
actor StubSharedWorld: SpacesService, ThreadsService, GroupChatsService {
    private var spaceList: [SpaceSummary]
    private var memberList: [String: [SpaceMember]]
    private var invites: [SpaceInvitation] = []
    private var threadList: [SpaceThread]
    private var messageList: [String: [ThreadMessage]]
    private var chatList: [GroupChat]
    private var nextSequence = 100

    private let delay: Duration = demoDelay
    nonisolated private static let sampleToken = String(repeating: "d", count: 43)

    init(now: Date = Date()) {
        let you = SpaceMember(userID: demoUser, displayName: "You", handle: "you", email: "you@example.com", role: .owner, joinedAt: now)
        let sam = SpaceMember(userID: demoSam, displayName: "Sam Rivera", handle: "sam", email: "sam@example.com", role: .admin, joinedAt: now)
        let jo = SpaceMember(userID: demoJo, displayName: "Jo Park", handle: "jo", email: "jo@example.com", role: .member, joinedAt: now)
        spaceList = [
            SpaceSummary(id: demoSpace, kind: .private, name: "Personal", role: .owner, updatedAt: now.addingTimeInterval(-7200)),
            SpaceSummary(id: demoFamily, kind: .group, name: "Family", role: .owner, updatedAt: now, unreadCount: 2, threadCount: 2, lastActivityAt: now.addingTimeInterval(-600)),
            SpaceSummary(id: demoBooks, kind: .group, name: "Book club", role: .member, updatedAt: now, threadCount: 1, lastActivityAt: now.addingTimeInterval(-86400))
        ]
        memberList = [
            demoSpace: [you],
            demoFamily: [you, sam, jo],
            demoBooks: [SpaceMember(userID: demoUser, displayName: "You", handle: "you", email: "you@example.com", role: .member), SpaceMember(userID: demoJo, displayName: "Jo Park", handle: "jo", email: "jo@example.com", role: .owner)],
            demoChatSpace: [you, SpaceMember(userID: demoSam, displayName: "Sam Rivera", handle: "sam", role: .member)]
        ]
        threadList = [
            SpaceThread(id: "demo-th1", spaceID: demoFamily, title: "Family holiday plans", createdBy: demoSam, lastSequence: 4, unreadCount: 2, createdAt: now.addingTimeInterval(-86400), updatedAt: now.addingTimeInterval(-600)),
            SpaceThread(id: "demo-th2", spaceID: demoFamily, title: "Weekend dinner", createdBy: demoUser, lastSequence: 1, createdAt: now.addingTimeInterval(-172800), updatedAt: now.addingTimeInterval(-90000)),
            SpaceThread(id: "demo-th3", spaceID: demoBooks, title: "Next month's pick", createdBy: demoJo, lastSequence: 1, createdAt: now.addingTimeInterval(-172800), updatedAt: now.addingTimeInterval(-86400)),
            SpaceThread(id: demoChat, spaceID: demoChatSpace, title: "Saturday plans", createdBy: demoUser, lastSequence: 2, createdAt: now.addingTimeInterval(-3600), updatedAt: now.addingTimeInterval(-1800))
        ]
        func message(_ id: String, _ thread: String, _ space: String, _ author: String?, _ body: String, _ sequence: Int, ago: TimeInterval, revision: Int = 1, deleted: Bool = false) -> ThreadMessage {
            ThreadMessage(id: id, threadID: thread, spaceID: space, authorUserID: author, body: deleted ? "" : body, sequence: sequence, clientMessageID: id, revision: revision, tombstonedAt: deleted ? now : nil, createdAt: now.addingTimeInterval(-ago), updatedAt: now.addingTimeInterval(-ago))
        }
        messageList = [
            "demo-th1": [
                message("m1", "demo-th1", demoFamily, demoSam, "Are we still thinking about the coast in August?", 1, ago: 7200),
                message("m2", "demo-th1", demoFamily, demoJo, "Yes! I found a cottage near the ferry. @sam can you check the dates?", 2, ago: 6000, revision: 2),
                message("m3", "demo-th1", demoFamily, demoUser, "@bob what's the weather like there in August?", 3, ago: 900),
                message("m4", "demo-th1", demoFamily, nil, "Usually **mild and breezy**, about 20°C, with the odd shower. Pack a light jacket.", 4, ago: 600)
            ],
            "demo-th2": [message("m5", "demo-th2", demoFamily, demoUser, "Who's cooking on Sunday?", 1, ago: 90000)],
            "demo-th3": [message("m6", "demo-th3", demoBooks, demoJo, "Short one this time, please.", 1, ago: 86400)],
            demoChat: [
                message("m7", demoChat, demoChatSpace, demoSam, "Park or pictures on Saturday?", 1, ago: 3600),
                message("m8", demoChat, demoChatSpace, demoUser, "Depends on the rain.", 2, ago: 1800)
            ]
        ]
        chatList = [GroupChat(id: demoChat, spaceID: demoChatSpace, title: "Saturday plans", createdBy: demoUser, role: .owner, createdAt: now.addingTimeInterval(-3600), updatedAt: now.addingTimeInterval(-1800))]
    }

    private func pause() async throws { try await Task.sleep(for: delay) }

    private func index(space id: String) throws -> Int {
        guard let index = spaceList.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        return index
    }

    // MARK: Spaces

    func selfUserID() async throws -> String? { demoUser }

    func spaces(archived: Bool) async throws -> [SpaceSummary] {
        try await pause()
        return spaceList.filter { ($0.archivedAt != nil) == archived }.map { space in
            var space = space
            space.unreadCount = threadList.filter { $0.spaceID == space.id }.map(\.unreadCount).reduce(0, +)
            space.threadCount = threadList.filter { $0.spaceID == space.id && $0.archivedAt == nil }.count
            return space
        }
    }

    func space(id: String) async throws -> SpaceSummary {
        spaceList[try index(space: id)]
    }

    func create(name: String) async throws -> SpaceSummary {
        try await pause()
        let space = SpaceSummary(id: UUID().uuidString, kind: .group, name: name, role: .owner, updatedAt: Date())
        spaceList.append(space)
        memberList[space.id] = [SpaceMember(userID: demoUser, displayName: "You", handle: "you", email: "you@example.com", role: .owner)]
        return space
    }

    func rename(spaceID: String, name: String) async throws -> SpaceSummary {
        try await pause()
        let at = try index(space: spaceID)
        spaceList[at].name = name
        return spaceList[at]
    }

    private func replacing(_ space: SpaceSummary, archivedAt: Date?) -> SpaceSummary {
        SpaceSummary(id: space.id, kind: space.kind, name: space.name, role: space.role, archivedAt: archivedAt, updatedAt: Date())
    }

    func restore(spaceID: String) async throws -> SpaceSummary {
        try await pause()
        let at = try index(space: spaceID)
        spaceList[at] = replacing(spaceList[at], archivedAt: nil)
        return spaceList[at]
    }

    func archive(spaceID: String) async throws -> SpaceSummary {
        try await pause()
        let at = try index(space: spaceID)
        spaceList[at] = replacing(spaceList[at], archivedAt: Date())
        return spaceList[at]
    }

    func members(spaceID: String) async throws -> [SpaceMember] {
        memberList[spaceID] ?? []
    }

    func removeMember(spaceID: String, userID: String) async throws {
        try await pause()
        memberList[spaceID]?.removeAll { $0.userID == userID }
        if userID == demoUser { spaceList.removeAll { $0.id == spaceID } }
    }

    func setRole(spaceID: String, userID: String, role: InviteRole) async throws {
        try await pause()
        guard let at = memberList[spaceID]?.firstIndex(where: { $0.userID == userID }) else { throw ApiError.notFound }
        memberList[spaceID]?[at].role = role == .admin ? .admin : .member
    }

    func transferOwner(spaceID: String, userID: String) async throws -> SpaceSummary {
        try await pause()
        let at = try index(space: spaceID)
        memberList[spaceID] = memberList[spaceID]?.map { member in
            var member = member
            if member.userID == userID { member.role = .owner }
            if member.userID == demoUser { member.role = .admin }
            return member
        }
        spaceList[at].role = .admin
        return spaceList[at]
    }

    func invitations(spaceID: String) async throws -> [SpaceInvitation] {
        try await pause()
        guard SpaceRules.isPrivileged(spaceList[try index(space: spaceID)].role) else { throw ApiError.forbidden }
        return invites.filter { $0.spaceID == spaceID }
    }

    func invite(spaceID: String, email: String, role: InviteRole) async throws -> IssuedInvitation {
        try await pause()
        let invitation = SpaceInvitation(id: UUID().uuidString, spaceID: spaceID, invitedEmail: email, role: role == .admin ? .admin : .member, expiresAt: Date().addingTimeInterval(86400 * 7), createdAt: Date())
        invites.insert(invitation, at: 0)
        // The demo sends no mail, so it shows the link a failed send falls back to.
        return IssuedInvitation(invitation: invitation, token: Self.sampleToken, emailSent: false)
    }

    func revokeInvitation(id: String) async throws {
        try await pause()
        invites.removeAll { $0.id == id }
    }

    func previewInvitation(token: String) async throws -> InvitationPreview {
        try await pause()
        guard token == Self.sampleToken else { throw ApiError.notFound }
        return InvitationPreview(spaceName: "Garden club", inviterName: "Jo Park", role: .member, expiresAt: Date().addingTimeInterval(86400 * 7))
    }

    func acceptInvitation(token: String) async throws -> InvitationOutcome {
        try await pause()
        guard token == Self.sampleToken else { return .notFound }
        guard !spaceList.contains(where: { $0.name == "Garden club" }) else { return .alreadyMember }
        let space = SpaceSummary(id: UUID().uuidString, kind: .group, name: "Garden club", role: .member, updatedAt: Date())
        spaceList.append(space)
        memberList[space.id] = [SpaceMember(userID: demoUser, displayName: "You", handle: "you", email: "you@example.com", role: .member), SpaceMember(userID: demoJo, displayName: "Jo Park", handle: "jo", role: .owner)]
        return .accepted
    }

    func agenda(spaceID: String, from: Date, to: Date) async throws -> AgendaPage {
        AgendaPage(items: [])
    }

    // MARK: Threads

    func threads(spaceID: String) async throws -> [SpaceThread] {
        try await pause()
        return threadList.filter { $0.spaceID == spaceID && $0.archivedAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func create(spaceID: String, title: String) async throws -> SpaceThread {
        try await pause()
        let thread = SpaceThread(id: UUID().uuidString, spaceID: spaceID, title: title, createdBy: demoUser, createdAt: Date(), updatedAt: Date())
        threadList.append(thread)
        messageList[thread.id] = []
        return thread
    }

    func thread(id: String) async throws -> SpaceThread {
        guard let thread = threadList.first(where: { $0.id == id }) else { throw ApiError.notFound }
        return thread
    }

    func rename(threadID: String, title: String) async throws -> SpaceThread {
        try await pause()
        guard let at = threadList.firstIndex(where: { $0.id == threadID }) else { throw ApiError.notFound }
        threadList[at].title = title
        if let chat = chatList.firstIndex(where: { $0.id == threadID }) { chatList[chat].title = title }
        return threadList[at]
    }

    func archive(threadID: String) async throws -> SpaceThread {
        try await pause()
        guard let at = threadList.firstIndex(where: { $0.id == threadID }) else { throw ApiError.notFound }
        let old = threadList[at]
        threadList[at] = SpaceThread(id: old.id, spaceID: old.spaceID, title: old.title, createdBy: old.createdBy, archivedAt: Date(), lastSequence: old.lastSequence, createdAt: old.createdAt, updatedAt: Date())
        return threadList[at]
    }

    func messages(threadID: String) async throws -> ThreadMessages {
        ThreadMessages(messages: messageList[threadID] ?? [])
    }

    private func append(threadID: String, author: String?, body: String) -> ThreadMessage {
        nextSequence += 1
        let space = threadList.first { $0.id == threadID }?.spaceID ?? demoFamily
        let message = ThreadMessage(id: UUID().uuidString, threadID: threadID, spaceID: space, authorUserID: author, body: body, sequence: nextSequence, clientMessageID: UUID().uuidString, createdAt: Date(), updatedAt: Date())
        messageList[threadID, default: []].append(message)
        return message
    }

    func post(threadID: String, body: String, clientMessageID: String) async throws -> ThreadMessage {
        try await pause()
        let message = append(threadID: threadID, author: demoUser, body: body)
        let others = (memberList[message.spaceID] ?? []).contains { $0.userID == demoSam }
        if others, !RoomMentions.addressesBob(body) {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                await self?.samAnswers(threadID: threadID)
            }
        }
        return message
    }

    private func samAnswers(threadID: String) {
        _ = append(threadID: threadID, author: demoSam, body: "Sounds good to me.")
    }

    func edit(messageID: String, body: String) async throws -> ThreadMessage {
        try await pause()
        return try change(messageID) { old in
            ThreadMessage(id: old.id, threadID: old.threadID, spaceID: old.spaceID, authorUserID: old.authorUserID, body: body, sequence: old.sequence, clientMessageID: old.clientMessageID, revision: old.revision + 1, createdAt: old.createdAt, updatedAt: Date(), origin: old.origin)
        }
    }

    func delete(messageID: String) async throws -> ThreadMessage {
        try await pause()
        return try change(messageID) { old in
            ThreadMessage(id: old.id, threadID: old.threadID, spaceID: old.spaceID, authorUserID: old.authorUserID, body: "", sequence: old.sequence, clientMessageID: old.clientMessageID, revision: old.revision + 1, tombstonedAt: Date(), createdAt: old.createdAt, updatedAt: Date(), origin: old.origin)
        }
    }

    private func change(_ id: String, _ transform: (ThreadMessage) -> ThreadMessage) throws -> ThreadMessage {
        for (thread, messages) in messageList {
            if let at = messages.firstIndex(where: { $0.id == id }) {
                let new = transform(messages[at])
                messageList[thread]?[at] = new
                return new
            }
        }
        throw ApiError.notFound
    }

    func markRead(threadID: String, through sequence: Int?) async throws {
        if let at = threadList.firstIndex(where: { $0.id == threadID }) { threadList[at].unreadCount = 0 }
    }

    func askBob(threadID: String, triggerMessageID: String) async throws -> AskBobOutcome {
        try await Task.sleep(for: .seconds(2))
        _ = append(threadID: threadID, author: nil, body: "I'm in **demo mode**, so this is a sample reply. Everyone in this conversation can see it.")
        return .answered
    }

    // MARK: Group chats

    func chats() async throws -> [GroupChat] {
        try await pause()
        return chatList
    }

    func chat(id: String) async throws -> GroupChat {
        guard let chat = chatList.first(where: { $0.id == id }) else { throw ApiError.notFound }
        return chat
    }

    func create(requestID: String, sourceConversationID: String?, textOnly: Bool) async throws -> GroupChat {
        try await pause()
        if let existing = chatList.first(where: { $0.id == requestID }) { return existing }
        let space = UUID().uuidString
        let chat = GroupChat(id: requestID, spaceID: space, title: "Chat", createdBy: demoUser, role: .owner, createdAt: Date(), updatedAt: Date())
        chatList.insert(chat, at: 0)
        memberList[space] = [SpaceMember(userID: demoUser, displayName: "You", handle: "you", role: .owner)]
        threadList.append(SpaceThread(id: chat.id, spaceID: space, title: chat.title, createdBy: demoUser, createdAt: Date(), updatedAt: Date()))
        messageList[chat.id] = []
        return chat
    }

    func preview(token: String) async throws -> GroupChatPreview {
        try await pause()
        throw ApiError.notFound
    }

    func accept(token: String) async throws -> GroupChat {
        try await pause()
        throw ApiError.notFound
    }

    func createLink(chatID: String) async throws -> GroupChatLink {
        try await pause()
        return GroupChatLink(token: Self.sampleToken, expiresAt: Date().addingTimeInterval(86400 * 7))
    }

    func disableLinks(chatID: String) async throws { try await pause() }

    func invite(chatID: String, email: String) async throws { try await pause() }

    private func spaceOf(chat id: String) -> String { chatList.first { $0.id == id }?.spaceID ?? "" }

    func members(chatID: String) async throws -> [GroupChatMember] {
        (memberList[spaceOf(chat: chatID)] ?? []).map { GroupChatMember(userID: $0.userID, displayName: $0.displayName, role: $0.role) }
    }

    func removeMember(chatID: String, userID: String) async throws {
        try await pause()
        memberList[spaceOf(chat: chatID)]?.removeAll { $0.userID == userID }
        if userID == demoUser { chatList.removeAll { $0.id == chatID } }
    }
}

actor StubSpaceScope: SpaceScoping {
    private let world: StubSharedWorld
    private(set) var selected: String = demoSpace

    init(world: StubSharedWorld) {
        self.world = world
    }

    func me() async throws -> String? { demoUser }
    func spaces() async throws -> [SpaceSummary] { try await world.spaces(archived: false) }
    func selectedID() async throws -> String { selected }
    func select(_ spaceID: String) { selected = spaceID }
    func members() async throws -> [SpaceMember] { try await world.members(spaceID: selected) }
}
