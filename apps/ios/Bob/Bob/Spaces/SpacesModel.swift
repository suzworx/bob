import BobKit
import Foundation
import Observation

// What the Home tab knows about spaces. Lives only in memory and leaves with the session.
@MainActor @Observable final class SpacesModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var spaces: [SpaceSummary] = []
    private(set) var archived: [SpaceSummary] = []
    private(set) var archivedPhase: LoadPhase = .loading
    var message: String?
    var undo: UndoOffer?

    let service: SpacesService
    let groupChats: GroupChatsService
    private var loadID = 0

    init(service: SpacesService, groupChats: GroupChatsService) {
        self.service = service
        self.groupChats = groupChats
    }

    var sorted: [SpaceSummary] { SpaceRules.byActivity(spaces) }

    func space(id: String) -> SpaceSummary? { spaces.first { $0.id == id } }

    func refresh() async {
        loadID += 1
        let id = loadID
        do {
            let found = try await service.spaces(archived: false)
            guard id == loadID else { return }
            spaces = found
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard id == loadID else { return }
            if spaces.isEmpty { phase = .failed(apiError(error)) }
        }
    }

    func refreshArchived() async {
        archivedPhase = archived.isEmpty ? .loading : archivedPhase
        do {
            archived = try await service.spaces(archived: true)
            archivedPhase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            archivedPhase = .failed(apiError(error))
        }
    }

    // Throws so the sheet keeps the name and says why.
    func create(name: String) async throws -> SpaceSummary {
        let space = try await service.create(name: name)
        spaces.append(space)
        return space
    }

    func rename(_ space: SpaceSummary, to name: String) async throws {
        let saved = try await service.rename(spaceID: space.id, name: name)
        if let index = spaces.firstIndex(where: { $0.id == space.id }) { spaces[index].name = saved.name }
    }

    // Reversible: it happens at once and is offered back.
    func archive(_ space: SpaceSummary) async -> Bool {
        do {
            _ = try await service.archive(spaceID: space.id)
            spaces.removeAll { $0.id == space.id }
            undo = UndoOffer(message: "Archived \(space.name)") { [weak self] in
                await self?.restore(space)
            }
            return true
        } catch {
            message = productivityMessage(error)
            return false
        }
    }

    func restore(_ space: SpaceSummary) async {
        do {
            _ = try await service.restore(spaceID: space.id)
            archived.removeAll { $0.id == space.id }
            await refresh()
            AccessibilityAnnouncer.say("Restored \(space.name)")
        } catch {
            message = productivityMessage(error)
        }
    }

    func leave(_ space: SpaceSummary, me: String) async -> Bool {
        do {
            try await service.removeMember(spaceID: space.id, userID: me)
            spaces.removeAll { $0.id == space.id }
            AccessibilityAnnouncer.say("You left \(space.name)")
            return true
        } catch {
            message = productivityMessage(error)
            return false
        }
    }
}

// One space: its threads, the week's agenda and its people.
@MainActor @Observable final class SpaceDetailModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var space: SpaceSummary?
    private(set) var members: [SpaceMember] = []
    private(set) var threads: [SpaceThread] = []
    private(set) var invitations: [SpaceInvitation] = []
    private(set) var agenda: [AgendaItem] = []
    private(set) var agendaPhase: LoadPhase = .loading
    private var agendaLoadID = 0
    private(set) var me: String?
    private(set) var busy = false
    var message: String?

    let spaceID: String
    let service: SpacesService
    let threadsService: ThreadsService

    init(spaceID: String, shared: SharedServices) {
        self.spaceID = spaceID
        service = shared.spaces
        threadsService = shared.threads
    }

    func load() async {
        do {
            async let foundSpace = service.space(id: spaceID)
            async let foundMembers = service.members(spaceID: spaceID)
            let (loaded, people) = try await (foundSpace, foundMembers)
            space = loaded
            members = people
            phase = .loaded
            me = (try? await service.selfUserID()) ?? me
            if SpaceRules.isShared(loaded) {
                threads = (try? await threadsService.threads(spaceID: spaceID)) ?? threads
            }
            // A plain member isn't allowed the invitations, and that's no failure.
            if SpaceRules.canInvite(loaded) {
                invitations = (try? await service.invitations(spaceID: spaceID)) ?? []
            } else {
                invitations = []
            }
            await loadAgenda()
        } catch where isCancelled(error) {
            return
        } catch {
            if space == nil { phase = .failed(apiError(error)) } else { message = productivityMessage(error) }
        }
    }

    func loadAgenda() async {
        agendaLoadID += 1
        let request = agendaLoadID
        agendaPhase = .loading
        let calendar = Calendar.current
        let from = calendar.startOfDay(for: Date())
        guard let to = calendar.date(byAdding: .day, value: 7, to: from) else { return }
        do {
            let page = try await service.agenda(spaceID: spaceID, from: from, to: to)
            guard request == agendaLoadID, !Task.isCancelled else { return }
            agenda = page.items
            agendaPhase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard request == agendaLoadID, !Task.isCancelled else { return }
            agendaPhase = .failed(apiError(error))
        }
    }

    private func acting(_ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
        } catch {
            message = productivityMessage(error)
        }
    }

    func invite(email: String, role: InviteRole) async throws -> IssuedInvitation {
        let issued = try await service.invite(spaceID: spaceID, email: email, role: role)
        invitations.insert(issued.invitation, at: 0)
        return issued
    }

    func revoke(_ invitation: SpaceInvitation) async {
        await acting {
            try await service.revokeInvitation(id: invitation.id)
            invitations.removeAll { $0.id == invitation.id }
        }
    }

    func setRole(_ member: SpaceMember, role: InviteRole) async {
        await acting {
            try await service.setRole(spaceID: spaceID, userID: member.userID, role: role)
            members = try await service.members(spaceID: spaceID)
            AccessibilityAnnouncer.say("\(SpaceRules.displayName(member)) is now \(role.title)")
        }
    }

    func makeOwner(_ member: SpaceMember) async {
        await acting {
            space = try await service.transferOwner(spaceID: spaceID, userID: member.userID)
            members = try await service.members(spaceID: spaceID)
        }
    }

    func remove(_ member: SpaceMember) async {
        await acting {
            try await service.removeMember(spaceID: spaceID, userID: member.userID)
            members.removeAll { $0.userID == member.userID }
        }
    }

    func createThread(title: String) async throws -> SpaceThread {
        let thread = try await threadsService.create(spaceID: spaceID, title: title)
        threads.insert(thread, at: 0)
        return thread
    }

    func rename(_ thread: SpaceThread, to title: String) async throws {
        let saved = try await threadsService.rename(threadID: thread.id, title: title)
        if let index = threads.firstIndex(where: { $0.id == thread.id }) { threads[index].title = saved.title }
    }

    func archive(_ thread: SpaceThread) async {
        await acting {
            _ = try await threadsService.archive(threadID: thread.id)
            threads.removeAll { $0.id == thread.id }
            AccessibilityAnnouncer.say("Archived \(thread.title)")
        }
    }

    func canArchive(_ thread: SpaceThread) -> Bool {
        guard let space else { return false }
        return SpaceRules.canArchive(thread: thread, in: space, me: me)
    }

    func canRemove(_ member: SpaceMember) -> Bool {
        guard let space else { return false }
        return SpaceRules.canRemove(member: member, in: space, me: me)
    }
}

// Shared chats. Their messages are thread messages; this is who's in them and how people get in.
@MainActor @Observable final class GroupChatsModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var chats: [GroupChat] = []
    var message: String?

    let service: GroupChatsService
    // Kept across a failed try so a retry can't make a second chat.
    @ObservationIgnored private var requestID: String?

    init(service: GroupChatsService) {
        self.service = service
    }

    var sorted: [GroupChat] { chats.sorted { $0.updatedAt > $1.updatedAt } }

    func refresh() async {
        do {
            chats = try await service.chats()
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            if chats.isEmpty { phase = .failed(apiError(error)) }
        }
    }

    // Throws so the caller can offer text only when the history can't all be copied.
    func create(sourceConversationID: String? = nil, textOnly: Bool = false) async throws -> GroupChat {
        let id = requestID ?? UUID().uuidString
        requestID = id
        let chat = try await service.create(requestID: id, sourceConversationID: sourceConversationID, textOnly: textOnly)
        requestID = nil
        if !chats.contains(where: { $0.id == chat.id }) { chats.insert(chat, at: 0) }
        return chat
    }

    func forgetRequest() {
        requestID = nil
    }

    func removed(_ chatID: String) {
        chats.removeAll { $0.id == chatID }
    }
}
