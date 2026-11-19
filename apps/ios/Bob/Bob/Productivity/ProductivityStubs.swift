import BobKit
import Foundation

// In-memory services with made-up content, for previews and the demo build: no network, and every action works.
nonisolated let demoSpace = "demo-space"
nonisolated let demoUser = "demo-user"
nonisolated let demoDelay: Duration = .milliseconds(250)

enum StubMode: Sendable {
    case demo
    case empty
    case failing(ApiError)
}

actor StubTasksService: TasksService {
    private var all: [TaskItem]
    private var following: Set<String> = []
    private let mode: StubMode
    private let delay: Duration
    private let scope: StubSpaceScope?

    init(mode: StubMode = .demo, delay: Duration = demoDelay, now: Date = Date(), scope: StubSpaceScope? = nil) {
        self.mode = mode
        self.delay = delay
        self.scope = scope
        if case .demo = mode {
            let today = WallClock.day(now, zone: TimeZone.current.identifier)
            let later = WallClock.day(now.addingTimeInterval(86400 * 4), zone: TimeZone.current.identifier)
            all = [
                Self.make("demo-t1", "Send the trip form", due: .date(today), order: "a1", now: now),
                Self.make("demo-t2", "Book the dentist", body: "Ask about Tuesday mornings", assignee: demoUser, due: .date(later), order: "a2", now: now),
                Self.make("demo-t3", "Pick a birthday present", order: "a3", now: now),
                Self.make("demo-i1", "Check the size", parent: "demo-t3", order: "b1", now: now),
                Self.make("demo-i2", "Wrap it", parent: "demo-t3", order: "b2", now: now),
                Self.make("demo-t4", "Book the ferry", assignee: demoSam, order: "c1", now: now, space: demoFamily),
                Self.make("demo-t5", "Find the passports", assignee: demoUser, due: .date(later), order: "c2", now: now, space: demoFamily)
            ]
        } else {
            all = []
        }
    }

    nonisolated private static func make(_ id: String, _ title: String, body: String? = nil, parent: String? = nil, assignee: String? = nil, due: TaskDue? = nil, order: String, now: Date, space: String = demoSpace) -> TaskItem {
        TaskItem(id: id, spaceID: space, parentTaskID: parent, title: title, body: body, assigneeUserID: assignee, due: due, orderKey: order, createdBy: demoUser, createdAt: now, updatedAt: now)
    }

    private func pause() async throws {
        if delay > .zero { try await Task.sleep(for: delay) }
        if case .failing(let error) = mode { throw error }
    }

    private func index(_ id: String) throws -> Int {
        guard let index = all.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        return index
    }

    func selfUserID() async throws -> String? { demoUser }

    func tasks() async throws -> [TaskItem] {
        try await pause()
        let space = await scope?.selected
        return all.filter { $0.parentTaskID == nil && $0.trashedAt == nil && (space == nil || $0.spaceID == space) }
    }

    func trashed() async throws -> [TaskItem] {
        try await pause()
        let space = await scope?.selected
        return all.filter { $0.parentTaskID == nil && $0.trashedAt != nil && (space == nil || $0.spaceID == space) }
    }

    func create(title: String, body: String?, due: TaskDue?, assignee: String?) async throws -> TaskItem {
        try await pause()
        let space = await scope?.selected ?? demoSpace
        let task = Self.make(UUID().uuidString, title, body: body, assignee: assignee, due: due, order: "z\(all.count)", now: Date(), space: space)
        all.append(task)
        return task
    }

    func task(id: String) async throws -> TaskItem {
        all[try index(id)]
    }

    func update(id: String, revision: Int, changes: TaskChanges) async throws -> TaskItem {
        try await pause()
        let at = try index(id)
        guard all[at].revision == revision else { throw RevisionConflict(currentRevision: all[at].revision) }
        if let status = changes.status {
            all[at].status = status
            all[at].completedAt = status == .completed ? Date() : nil
        }
        if let title = changes.title { all[at].title = title }
        if let body = changes.body { all[at].body = body }
        if let due = changes.due { all[at].due = due }
        if let assignee = changes.assigneeUserID { all[at].assigneeUserID = assignee }
        if let space = changes.spaceID {
            var moved = all[at]
            moved = TaskItem(id: moved.id, spaceID: space, parentTaskID: moved.parentTaskID, title: moved.title, body: moved.body, status: moved.status, assigneeUserID: nil, due: moved.due, orderKey: moved.orderKey, revision: moved.revision, createdBy: moved.createdBy, createdAt: moved.createdAt, updatedAt: moved.updatedAt)
            all[at] = moved
        }
        all[at].revision += 1
        all[at].updatedAt = Date()
        return all[at]
    }

    func delete(id: String) async throws {
        try await pause()
        all[try index(id)].trashedAt = Date()
    }

    func restore(id: String) async throws -> TaskItem {
        try await pause()
        let at = try index(id)
        all[at].trashedAt = nil
        return all[at]
    }

    func items(taskID: String) async throws -> [TaskItem] {
        try await pause()
        return all.filter { $0.parentTaskID == taskID && $0.trashedAt == nil }
    }

    func addItem(taskID: String, title: String) async throws -> TaskItem {
        try await pause()
        let item = Self.make(UUID().uuidString, title, parent: taskID, order: "z\(all.count)", now: Date())
        all.append(item)
        return item
    }

    func moveItem(taskID: String, itemID: String, revision: Int, move: TaskItemMove) async throws -> TaskItem {
        try await pause()
        var item = all.remove(at: try index(itemID))
        item.revision += 1
        switch move {
        case .before(let id): all.insert(item, at: try index(id))
        case .after(let id): all.insert(item, at: try index(id) + 1)
        }
        return item
    }

    func followers(taskID: String) async throws -> [String] {
        following.contains(taskID) ? [demoUser] : []
    }

    func setFollowing(taskID: String, userID: String, following isFollowing: Bool) async throws {
        try await pause()
        if isFollowing {
            following.insert(taskID)
        } else {
            following.remove(taskID)
        }
    }
}

actor StubNotesService: NotesService {
    private var all: [Note]
    private var history: [String: [NoteRevision]] = [:]
    private let mode: StubMode
    private let delay: Duration
    private let scope: StubSpaceScope?

    init(mode: StubMode = .demo, delay: Duration = demoDelay, now: Date = Date(), scope: StubSpaceScope? = nil) {
        self.mode = mode
        self.delay = delay
        self.scope = scope
        if case .demo = mode {
            all = [
                Note(id: "demo-n1", spaceID: demoSpace, title: "Gift ideas", body: "A good umbrella\nThat book about bees", pinned: true, createdBy: demoUser, updatedBy: demoUser, createdAt: now, updatedAt: now),
                Note(id: "demo-n2", spaceID: demoSpace, title: "Holiday packing", body: "Sun cream, hats, chargers", createdBy: demoUser, updatedBy: demoUser, createdAt: now, updatedAt: now.addingTimeInterval(-86400)),
                Note(id: "demo-n3", spaceID: demoFamily, title: "Ferry times", body: "08:15 or 11:40 from the north dock", createdBy: demoSam, updatedBy: demoSam, createdAt: now, updatedAt: now)
            ]
        } else {
            all = []
        }
    }

    private func pause() async throws {
        if delay > .zero { try await Task.sleep(for: delay) }
        if case .failing(let error) = mode { throw error }
    }

    private func index(_ id: String) throws -> Int {
        guard let index = all.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        return index
    }

    func notes() async throws -> [Note] {
        try await pause()
        let space = await scope?.selected
        return all.filter { space == nil || $0.spaceID == space }
    }

    func publish(noteID: String, toSpace spaceID: String, includingBody: Bool) async throws -> Note {
        try await pause()
        let source = all[try index(noteID)]
        let copy = Note(id: UUID().uuidString, spaceID: spaceID, title: source.title, body: includingBody ? source.body : "", createdBy: demoUser, updatedBy: demoUser, createdAt: Date(), updatedAt: Date())
        all.append(copy)
        return copy
    }

    func search(query: String) async throws -> [Note] {
        try await pause()
        let space = await scope?.selected
        return all.filter { (space == nil || $0.spaceID == space) && $0.trashedAt == nil && ($0.title.localizedCaseInsensitiveContains(query) || $0.body.localizedCaseInsensitiveContains(query)) }
    }

    func create(title: String, body: String) async throws -> Note {
        try await pause()
        let space = await scope?.selected ?? demoSpace
        let note = Note(id: UUID().uuidString, spaceID: space, title: title, body: body, createdBy: demoUser, updatedBy: demoUser, createdAt: Date(), updatedAt: Date())
        all.append(note)
        return note
    }

    func note(id: String) async throws -> Note {
        all[try index(id)]
    }

    func update(id: String, revision: Int, title: String, body: String) async throws -> Note {
        try await pause()
        let at = try index(id)
        guard all[at].revision == revision else { throw RevisionConflict(currentRevision: all[at].revision) }
        history[id, default: []].insert(NoteRevision(id: UUID().uuidString, noteID: id, revision: all[at].revision, title: all[at].title, body: all[at].body, editorUserID: demoUser, createdAt: all[at].updatedAt), at: 0)
        all[at].title = title
        all[at].body = body
        all[at].revision += 1
        all[at].updatedAt = Date()
        return all[at]
    }

    func setPinned(id: String, pinned: Bool) async throws -> Note {
        try await pause()
        let at = try index(id)
        all[at].pinned = pinned
        return all[at]
    }

    func delete(id: String) async throws {
        try await pause()
        all[try index(id)].trashedAt = Date()
    }

    func restore(id: String) async throws -> Note {
        try await pause()
        let at = try index(id)
        all[at].trashedAt = nil
        return all[at]
    }

    func revisions(noteID: String) async throws -> [NoteRevision] {
        try await pause()
        return history[noteID] ?? []
    }
}

actor StubRemindersService: RemindersService {
    private var all: [Reminder]
    private let mode: StubMode
    private let delay: Duration
    private let scope: StubSpaceScope?

    init(mode: StubMode = .demo, delay: Duration = demoDelay, now: Date = Date(), scope: StubSpaceScope? = nil) {
        self.mode = mode
        self.delay = delay
        self.scope = scope
        let zone = TimeZone.current.identifier
        if case .demo = mode {
            all = [
                Reminder(id: "demo-r1", spaceID: demoSpace, title: "Call the school", dueAt: now.addingTimeInterval(3600), dueZone: zone),
                Reminder(id: "demo-r2", spaceID: demoSpace, title: "Take out the bins", dueAt: now.addingTimeInterval(86400 * 3), dueZone: zone),
                Reminder(id: "demo-r3", spaceID: demoSpace, title: "Water the plants", dueAt: now, dueZone: zone, rule: ReminderRule(freq: .weekly, byWeekday: [1, 4])),
                Reminder(id: "demo-r4", spaceID: demoFamily, title: "Pack the car", dueAt: now.addingTimeInterval(86400 * 5), dueZone: zone, recipientUserIDs: [demoUser, demoSam])
            ]
        } else {
            all = []
        }
    }

    private func pause() async throws {
        if delay > .zero { try await Task.sleep(for: delay) }
        if case .failing(let error) = mode { throw error }
    }

    private func index(_ id: String) throws -> Int {
        guard let index = all.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        return index
    }

    func reminders() async throws -> [Reminder] {
        try await pause()
        let space = await scope?.selected
        return all.filter { space == nil || $0.spaceID == space }
    }

    func create(title: String, due: ReminderDue, rule: ReminderRule?, recipients: [String]?) async throws -> Reminder {
        try await pause()
        let space = await scope?.selected ?? demoSpace
        let reminder = Reminder(id: UUID().uuidString, spaceID: space, title: title, dueAt: due.at, dueZone: due.zone, rule: rule, recipientUserIDs: recipients ?? [demoUser])
        all.append(reminder)
        return reminder
    }

    func createPrivate(title: String, due: ReminderDue, rule: ReminderRule?) async throws -> Reminder {
        try await pause()
        let reminder = Reminder(id: UUID().uuidString, spaceID: demoSpace, title: title, dueAt: due.at, dueZone: due.zone, rule: rule, recipientUserIDs: [demoUser])
        all.append(reminder)
        return reminder
    }

    func update(id: String, changes: ReminderChanges) async throws -> Reminder {
        try await pause()
        let at = try index(id)
        if let title = changes.title { all[at].title = title }
        if let due = changes.due {
            all[at].dueAt = due.at
            all[at].dueZone = due.zone
        }
        if let rule = changes.rule { all[at].rule = rule }
        return all[at]
    }

    func cancel(id: String) async throws -> Reminder {
        try await pause()
        let at = try index(id)
        all[at].status = .cancelled
        return all[at]
    }

    // A rough stand-in for the server's recurrence engine.
    func preview(due: ReminderDue, rule: ReminderRule?) async throws -> [ReminderOccurrencePreview] {
        guard rule != nil else {
            return [ReminderOccurrencePreview(at: due.at, wallTime: WallClock.time(due.at, zone: due.zone))]
        }
        return (0..<3).map { step in
            let at = due.at.addingTimeInterval(Double(step) * 86400)
            return ReminderOccurrencePreview(at: at, wallTime: WallClock.time(at, zone: due.zone))
        }
    }
}
