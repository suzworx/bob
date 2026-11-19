import BobKit
import Foundation

protocol TasksService: Sendable {
    func selfUserID() async throws -> String?
    func tasks() async throws -> [TaskItem]
    func trashed() async throws -> [TaskItem]
    func create(title: String, body: String?, due: TaskDue?, assignee: String?) async throws -> TaskItem
    func task(id: String) async throws -> TaskItem
    func update(id: String, revision: Int, changes: TaskChanges) async throws -> TaskItem
    func delete(id: String) async throws
    func restore(id: String) async throws -> TaskItem
    func items(taskID: String) async throws -> [TaskItem]
    func addItem(taskID: String, title: String) async throws -> TaskItem
    func moveItem(taskID: String, itemID: String, revision: Int, move: TaskItemMove) async throws -> TaskItem
    func followers(taskID: String) async throws -> [String]
    func setFollowing(taskID: String, userID: String, following: Bool) async throws
}

protocol NotesService: Sendable {
    func notes() async throws -> [Note]
    func search(query: String) async throws -> [Note]
    func create(title: String, body: String) async throws -> Note
    func publish(noteID: String, toSpace spaceID: String, includingBody: Bool) async throws -> Note
    func note(id: String) async throws -> Note
    func update(id: String, revision: Int, title: String, body: String) async throws -> Note
    func setPinned(id: String, pinned: Bool) async throws -> Note
    func delete(id: String) async throws
    func restore(id: String) async throws -> Note
    func revisions(noteID: String) async throws -> [NoteRevision]
}

protocol RemindersService: Sendable {
    func reminders() async throws -> [Reminder]
    // Nil recipients means just the person.
    func create(title: String, due: ReminderDue, rule: ReminderRule?, recipients: [String]?) async throws -> Reminder
    // Always in the person's private space, wherever Home is looking.
    func createPrivate(title: String, due: ReminderDue, rule: ReminderRule?) async throws -> Reminder
    func update(id: String, changes: ReminderChanges) async throws -> Reminder
    func cancel(id: String) async throws -> Reminder
    func preview(due: ReminderDue, rule: ReminderRule?) async throws -> [ReminderOccurrencePreview]
}

// Finds the person's private space once.
actor PrivateSpace {
    private let client: SpacesClient
    private var spaceID: String?
    private var memberIDs: [String]?

    init(client: SpacesClient) {
        self.client = client
    }

    func id() async throws -> String {
        if let spaceID { return spaceID }
        let id = try await client.privateSpace().id
        spaceID = id
        return id
    }

    // A private space has one member: the person, which is how the app knows who they are.
    func selfID() async throws -> String? {
        let members = try await members()
        return members.count == 1 ? members[0] : nil
    }

    func members() async throws -> [String] {
        if let memberIDs { return memberIDs }
        let members = try await client.members(spaceID: try await id()).map(\.userID)
        memberIDs = members
        return members
    }
}

struct LiveTasksService: TasksService {
    let client: TasksClient
    let space: LiveSpaceScope

    func selfUserID() async throws -> String? { try await space.me() }

    func tasks() async throws -> [TaskItem] { try await client.tasks(spaceID: try await space.selectedID()) }
    func trashed() async throws -> [TaskItem] { try await client.trashedTasks(spaceID: try await space.selectedID()) }
    func create(title: String, body: String?, due: TaskDue?, assignee: String?) async throws -> TaskItem {
        try await client.create(spaceID: try await space.selectedID(), title: title, body: body, due: due, assigneeUserID: assignee)
    }
    func task(id: String) async throws -> TaskItem { try await client.task(id: id) }
    func update(id: String, revision: Int, changes: TaskChanges) async throws -> TaskItem {
        try await client.update(id: id, revision: revision, changes: changes)
    }
    func delete(id: String) async throws { try await client.delete(id: id) }
    func restore(id: String) async throws -> TaskItem { try await client.restore(id: id) }
    func items(taskID: String) async throws -> [TaskItem] { try await client.items(taskID: taskID) }
    func addItem(taskID: String, title: String) async throws -> TaskItem { try await client.addItem(taskID: taskID, title: title) }
    func moveItem(taskID: String, itemID: String, revision: Int, move: TaskItemMove) async throws -> TaskItem {
        try await client.moveItem(taskID: taskID, itemID: itemID, revision: revision, move: move)
    }
    func followers(taskID: String) async throws -> [String] { try await client.subscribers(taskID: taskID).map(\.userID) }
    func setFollowing(taskID: String, userID: String, following: Bool) async throws {
        if following {
            try await client.addSubscriber(taskID: taskID, userID: userID)
        } else {
            try await client.removeSubscriber(taskID: taskID, userID: userID)
        }
    }
}

struct LiveNotesService: NotesService {
    let client: NotesClient
    let space: LiveSpaceScope

    func notes() async throws -> [Note] { try await client.notes(spaceID: try await space.selectedID()) }
    func search(query: String) async throws -> [Note] { try await client.search(spaceID: try await space.selectedID(), query: query) }
    func create(title: String, body: String) async throws -> Note {
        try await client.create(spaceID: try await space.selectedID(), title: title, body: body)
    }
    func publish(noteID: String, toSpace spaceID: String, includingBody: Bool) async throws -> Note {
        try await client.publish(noteID: noteID, toSpace: spaceID, includingBody: includingBody)
    }
    func note(id: String) async throws -> Note { try await client.note(id: id) }
    func update(id: String, revision: Int, title: String, body: String) async throws -> Note {
        try await client.update(id: id, revision: revision, title: title, body: body)
    }
    func setPinned(id: String, pinned: Bool) async throws -> Note { try await client.setPinned(id: id, pinned: pinned) }
    func delete(id: String) async throws { try await client.delete(id: id) }
    func restore(id: String) async throws -> Note { try await client.restore(id: id) }
    func revisions(noteID: String) async throws -> [NoteRevision] { try await client.revisions(noteID: noteID) }
}

struct LiveRemindersService: RemindersService {
    let client: RemindersClient
    let space: LiveSpaceScope

    func reminders() async throws -> [Reminder] { try await client.reminders(spaceID: try await space.selectedID()) }
    func create(title: String, due: ReminderDue, rule: ReminderRule?, recipients: [String]?) async throws -> Reminder {
        let chosen: [String]
        if let recipients {
            chosen = recipients
        } else if let me = try await space.me() {
            chosen = [me]
        } else {
            throw ApiError.invalidRequest
        }
        return try await client.create(spaceID: try await space.selectedID(), title: title, due: due, rule: rule, recipients: chosen)
    }
    func createPrivate(title: String, due: ReminderDue, rule: ReminderRule?) async throws -> Reminder {
        guard let me = try await space.me() else { throw ApiError.invalidRequest }
        return try await client.create(spaceID: try await space.homeID(), title: title, due: due, rule: rule, recipients: [me])
    }
    func update(id: String, changes: ReminderChanges) async throws -> Reminder { try await client.update(id: id, changes: changes) }
    func cancel(id: String) async throws -> Reminder { try await client.cancel(id: id) }
    func preview(due: ReminderDue, rule: ReminderRule?) async throws -> [ReminderOccurrencePreview] {
        try await client.preview(due: due, rule: rule)
    }
}

struct ProductivityServices {
    let tasks: TasksService
    let notes: NotesService
    let reminders: RemindersService
    let calendar: CalendarService
    let memory: MemoryService
    let search: SearchService
    let scope: SpaceScoping
    let shared: SharedServices

    // One demo, so what Siri adds shows on Home.
    private static var sharedDemo: ProductivityServices?

    // The server when there is one, otherwise demo data, which only a debug build can reach.
    @MainActor static func make(conversations: ConversationsService) -> ProductivityServices {
        let spaces = AppSession.make { SpacesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let tasks = AppSession.make { TasksClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let notes = AppSession.make { NotesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let reminders = AppSession.make { RemindersClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let calendar = AppSession.make { CalendarClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let agenda = AppSession.make { AgendaClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let memory = AppSession.make { MemoryClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let search = AppSession.make { SearchClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let threads = AppSession.make { ThreadsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let groupChats = AppSession.make { GroupChatsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        guard let spaces, let tasks, let notes, let reminders, let calendar, let agenda, let memory, let search, let threads, let groupChats else {
            let demo = sharedDemo ?? .demo(conversations: conversations)
            sharedDemo = demo
            return demo
        }
        let space = PrivateSpace(client: spaces)
        let scope = LiveSpaceScope(client: spaces, home: space)
        return ProductivityServices(
            tasks: LiveTasksService(client: tasks, space: scope),
            notes: LiveNotesService(client: notes, space: scope),
            reminders: LiveRemindersService(client: reminders, space: scope),
            calendar: LiveCalendarService(client: calendar, agenda: agenda, spaces: spaces, tasks: tasks, reminders: reminders, space: space),
            memory: LiveMemoryService(client: memory, space: space),
            search: LiveSearchService(client: search, conversations: conversations, memory: memory),
            scope: scope,
            shared: SharedServices(spaces: LiveSpacesService(client: spaces, agenda: agenda, home: space), threads: threads, groupChats: groupChats, linkBase: AppConfig.apiBaseURL ?? AppSession.productionBaseURL)
        )
    }
}

extension ProductivityServices {
    // In-memory services that share their tasks and reminders, so what's added on Home shows on the calendar.
    static func demo(conversations: ConversationsService = StubConversationsService()) -> ProductivityServices {
        let world = StubSharedWorld()
        let scope = StubSpaceScope(world: world)
        let tasks = StubTasksService(scope: scope)
        let reminders = StubRemindersService(scope: scope)
        let notes = StubNotesService(scope: scope)
        let memory = StubMemoryService()
        return ProductivityServices(
            tasks: tasks,
            notes: notes,
            reminders: reminders,
            calendar: StubCalendarService(tasks: tasks, reminders: reminders),
            memory: memory,
            search: StubSearchService(tasks: tasks, notes: notes, memory: memory, conversations: conversations),
            scope: scope,
            shared: SharedServices(spaces: world, threads: world, groupChats: world, linkBase: AppSession.productionBaseURL)
        )
    }
}

// A failure in words a person can read; nil for a cancelled request, which needs no message.
func productivityMessage(_ error: Error) -> String? {
    if error is RevisionConflict {
        return "This changed elsewhere, so your change wasn't saved. You're now seeing the latest."
    }
    if error is CancellationError { return nil }
    guard let api = error as? ApiError else {
        return ApiErrorMapper.userMessage(.unknown(status: 0))
    }
    return api == .cancelled ? nil : ApiErrorMapper.userMessage(api)
}

func apiError(_ error: Error) -> ApiError {
    error as? ApiError ?? .unknown(status: 0)
}

func isCancelled(_ error: Error) -> Bool {
    error is CancellationError || (error as? ApiError) == .cancelled
}
