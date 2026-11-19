import BobKit
import Foundation
import Observation

protocol SpacesService: Sendable {
    func selfUserID() async throws -> String?
    func spaces(archived: Bool) async throws -> [SpaceSummary]
    func space(id: String) async throws -> SpaceSummary
    func create(name: String) async throws -> SpaceSummary
    func rename(spaceID: String, name: String) async throws -> SpaceSummary
    func restore(spaceID: String) async throws -> SpaceSummary
    func archive(spaceID: String) async throws -> SpaceSummary
    func members(spaceID: String) async throws -> [SpaceMember]
    func removeMember(spaceID: String, userID: String) async throws
    func setRole(spaceID: String, userID: String, role: InviteRole) async throws
    func transferOwner(spaceID: String, userID: String) async throws -> SpaceSummary
    func invitations(spaceID: String) async throws -> [SpaceInvitation]
    func invite(spaceID: String, email: String, role: InviteRole) async throws -> IssuedInvitation
    func revokeInvitation(id: String) async throws
    func previewInvitation(token: String) async throws -> InvitationPreview
    func acceptInvitation(token: String) async throws -> InvitationOutcome
    func agenda(spaceID: String, from: Date, to: Date) async throws -> AgendaPage
}

protocol ThreadsService: Sendable {
    func threads(spaceID: String) async throws -> [SpaceThread]
    func create(spaceID: String, title: String) async throws -> SpaceThread
    func thread(id: String) async throws -> SpaceThread
    func rename(threadID: String, title: String) async throws -> SpaceThread
    func archive(threadID: String) async throws -> SpaceThread
    func messages(threadID: String) async throws -> ThreadMessages
    func post(threadID: String, body: String, clientMessageID: String) async throws -> ThreadMessage
    func edit(messageID: String, body: String) async throws -> ThreadMessage
    func delete(messageID: String) async throws -> ThreadMessage
    func markRead(threadID: String, through sequence: Int?) async throws
    func askBob(threadID: String, triggerMessageID: String) async throws -> AskBobOutcome
    func askBob(threadID: String, triggerMessageID: String, appBinding: ChatAppBinding?) async throws -> AskBobOutcome
}

extension ThreadsService {
    func askBob(threadID: String, triggerMessageID: String, appBinding: ChatAppBinding?) async throws -> AskBobOutcome {
        guard appBinding == nil else { throw ApiError.invalidRequest }
        return try await askBob(threadID: threadID, triggerMessageID: triggerMessageID)
    }
}

protocol GroupChatsService: Sendable {
    func chats() async throws -> [GroupChat]
    func chat(id: String) async throws -> GroupChat
    func create(requestID: String, sourceConversationID: String?, textOnly: Bool) async throws -> GroupChat
    func preview(token: String) async throws -> GroupChatPreview
    func accept(token: String) async throws -> GroupChat
    func createLink(chatID: String) async throws -> GroupChatLink
    func disableLinks(chatID: String) async throws
    func invite(chatID: String, email: String) async throws
    func members(chatID: String) async throws -> [GroupChatMember]
    func removeMember(chatID: String, userID: String) async throws
}

extension ThreadsClient: ThreadsService {}
extension GroupChatsClient: GroupChatsService {}

// Which space the Home tab's tasks, notes and reminders are working in.
protocol SpaceScoping: Sendable {
    func me() async throws -> String?
    func spaces() async throws -> [SpaceSummary]
    func selectedID() async throws -> String
    func select(_ spaceID: String) async
    func members() async throws -> [SpaceMember]
}

actor LiveSpaceScope: SpaceScoping {
    private let client: SpacesClient
    private let home: PrivateSpace
    private var selected: String?

    init(client: SpacesClient, home: PrivateSpace) {
        self.client = client
        self.home = home
    }

    func me() async throws -> String? { try await home.selfID() }
    func spaces() async throws -> [SpaceSummary] { try await client.spaces() }
    func selectedID() async throws -> String {
        if let selected { return selected }
        return try await home.id()
    }
    func select(_ spaceID: String) { selected = spaceID }
    func members() async throws -> [SpaceMember] { try await client.members(spaceID: try await selectedID()) }
    func homeID() async throws -> String { try await home.id() }
}

struct LiveSpacesService: SpacesService {
    let client: SpacesClient
    let agenda: AgendaClient
    let home: PrivateSpace

    func selfUserID() async throws -> String? { try await home.selfID() }
    func spaces(archived: Bool) async throws -> [SpaceSummary] { try await client.spaces(archived: archived) }
    func space(id: String) async throws -> SpaceSummary { try await client.space(id: id) }
    func create(name: String) async throws -> SpaceSummary { try await client.create(name: name) }
    func rename(spaceID: String, name: String) async throws -> SpaceSummary { try await client.rename(spaceID: spaceID, name: name) }
    func restore(spaceID: String) async throws -> SpaceSummary { try await client.restore(spaceID: spaceID) }
    func archive(spaceID: String) async throws -> SpaceSummary { try await client.archive(spaceID: spaceID) }
    func members(spaceID: String) async throws -> [SpaceMember] { try await client.members(spaceID: spaceID) }
    func removeMember(spaceID: String, userID: String) async throws { try await client.removeMember(spaceID: spaceID, userID: userID) }
    func setRole(spaceID: String, userID: String, role: InviteRole) async throws { try await client.setRole(spaceID: spaceID, userID: userID, role: role) }
    func transferOwner(spaceID: String, userID: String) async throws -> SpaceSummary { try await client.transferOwner(spaceID: spaceID, userID: userID) }
    func invitations(spaceID: String) async throws -> [SpaceInvitation] { try await client.invitations(spaceID: spaceID) }
    func invite(spaceID: String, email: String, role: InviteRole) async throws -> IssuedInvitation { try await client.invite(spaceID: spaceID, email: email, role: role) }
    func revokeInvitation(id: String) async throws { try await client.revokeInvitation(id: id) }
    func previewInvitation(token: String) async throws -> InvitationPreview { try await client.previewInvitation(token: token) }
    func acceptInvitation(token: String) async throws -> InvitationOutcome { try await client.acceptInvitation(token: token) }
    func agenda(spaceID: String, from: Date, to: Date) async throws -> AgendaPage { try await agenda.page(from: from, to: to, spaceID: spaceID) }
}

// The spaces, threads and group chats behind Home, in one place so each screen finds them.
struct SharedServices {
    let spaces: SpacesService
    let threads: ThreadsService
    let groupChats: GroupChatsService
    // Where a copied invitation link points.
    let linkBase: URL
}

// The space Tasks, Notes and Reminders are in, who else is there, and where they could go instead.
@MainActor @Observable final class ScopeModel {
    private(set) var spaces: [SpaceSummary] = []
    private(set) var currentID: String?
    private(set) var people: [SpaceMember] = []
    private(set) var me: String?
    // Bumped by a change of space, so an answer about the old one can't land.
    @ObservationIgnored private(set) var generation = 0

    @ObservationIgnored private let source: SpaceScoping

    init(source: SpaceScoping) {
        self.source = source
    }

    var current: SpaceSummary? { spaces.first { $0.id == currentID } }
    var isShared: Bool { current.map(SpaceRules.isShared) ?? false }
    var others: [SpaceSummary] { spaces.filter { $0.id != currentID } }
    var sharedSpaces: [SpaceSummary] { spaces.filter(SpaceRules.isShared) }

    // A failure leaves the picker as it was: the lists work without it.
    func load() async {
        me = (try? await source.me()) ?? me
        spaces = (try? await source.spaces()) ?? spaces
        currentID = (try? await source.selectedID()) ?? currentID
        people = (try? await source.members()) ?? people
    }

    func select(_ spaceID: String) async {
        generation += 1
        currentID = spaceID
        people = []
        await source.select(spaceID)
        people = (try? await source.members()) ?? []
    }

    func name(of userID: String?) -> String? {
        guard let userID else { return nil }
        if userID == me { return "You" }
        return people.first { $0.userID == userID }.map(SpaceRules.displayName)
    }
}
