import BobKit
import Foundation
import Observation

// The task list: a failed save puts the row back and says so once.
@MainActor @Observable final class TasksModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var tasks: [TaskItem] = []
    private(set) var me: String?
    private(set) var deleted: [TaskItem] = []
    private(set) var deletedPhase: LoadPhase = .loading
    var view: TaskView = .open
    var sort: TaskSort = .list
    var message: String?
    var undo: UndoOffer?

    private var detailTargets: [String: TaskItem] = [:]
    private var targetGeneration = 0

    let service: TasksService
    let scope: ScopeModel?

    init(service: TasksService, scope: ScopeModel? = nil) {
        self.service = service
        self.scope = scope
    }

    func forgetSpace() {
        targetGeneration += 1
        detailTargets = [:]
        tasks = []
        deleted = []
        phase = .loading
        deletedPhase = .loading
    }

    func task(id: String) -> TaskItem? {
        let listed = tasks.first { $0.id == id }
        guard let resolved = detailTargets[id] else { return listed }
        return (listed?.revision ?? -1) > resolved.revision ? listed : resolved
    }

    // Keep directly resolved targets even when a later list page doesn't include them.
    func loadTarget(id: String) async throws {
        let generation = targetGeneration
        let spaceGeneration = scope?.generation
        let spaceID = scope?.currentID
        let found = try await service.task(id: id)
        try Task.checkCancellation()
        guard generation == targetGeneration, spaceGeneration == scope?.generation else { throw CancellationError() }
        guard found.id == id else { throw ApiError.invalidRequest }
        if let spaceID, found.spaceID != spaceID { throw ApiError.forbidden }
        guard found.trashedAt == nil else { throw ApiError.notFound }
        let current = task(id: id)
        detailTargets[id] = (current?.revision ?? -1) > found.revision ? current : found
    }

    func groups(now: Date) -> [ProductivityGroup<TaskItem>] {
        let shown = TaskRules.sort(TaskRules.filter(tasks, view: view, me: me), by: sort)
        guard view != .done, sort == .list else {
            return shown.isEmpty ? [] : [ProductivityGroup(title: nil, rows: shown)]
        }
        return TaskRules.groups(shown, now: now)
    }

    func refresh() async {
        let generation = scope?.generation
        do {
            let found = try await service.tasks()
            guard generation == scope?.generation else { return }
            tasks = found
            phase = .loaded
            // "Mine" only needs this; the list still works without it.
            if me == nil { me = try? await service.selfUserID() }
        } catch where isCancelled(error) {
            return
        } catch {
            if tasks.isEmpty {
                phase = .failed(apiError(error))
            } else {
                message = productivityMessage(error)
            }
        }
    }

    func refreshDeleted() async {
        do {
            deleted = try await service.trashed()
            deletedPhase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            deletedPhase = .failed(apiError(error))
        }
    }

    func create(_ draft: TaskDraft, assignee: String? = nil) async throws {
        let created = try await service.create(title: draft.trimmedTitle, body: draft.noteBody, due: draft.due(baseDue: nil, defaultZone: TimeZone.current.identifier), assignee: assignee)
        tasks.insert(created, at: 0)
    }

    // It leaves this list, since the list shows one space. The server clears an assignee who isn't in the new space.
    func move(_ task: TaskItem, to space: SpaceSummary) async {
        do {
            _ = try await service.update(id: task.id, revision: task.revision, changes: TaskChanges(spaceID: space.id))
            detailTargets[task.id] = nil
            tasks.removeAll { $0.id == task.id }
            AccessibilityAnnouncer.say("Moved \(task.title) to \(space.name)")
        } catch {
            if error is RevisionConflict { await refresh() }
            message = productivityMessage(error)
        }
    }

    // Throws so an editor can keep its draft; the list is reloaded on a conflict.
    func update(_ task: TaskItem, changes: TaskChanges) async throws {
        do {
            replace(try await service.update(id: task.id, revision: task.revision, changes: changes))
        } catch is RevisionConflict {
            try? await loadTarget(id: task.id)
            await refresh()
            throw RevisionConflict(currentRevision: self.task(id: task.id)?.revision ?? task.revision)
        }
    }

    func toggle(_ task: TaskItem) async {
        let status = task.status.toggled
        var optimistic = task
        optimistic.status = status
        replace(optimistic)
        do {
            replace(try await service.update(id: task.id, revision: task.revision, changes: TaskChanges(status: status)))
            if status == .completed {
                undo = UndoOffer(message: "Completed \(task.title)") { [weak self] in
                    guard let self, let current = self.task(id: task.id) else { return }
                    await self.toggle(current)
                }
            }
        } catch {
            replace(task)
            if error is RevisionConflict { await refresh() }
            message = productivityMessage(error)
        }
    }

    func delete(_ task: TaskItem) async {
        detailTargets[task.id] = nil
        tasks.removeAll { $0.id == task.id }
        do {
            try await service.delete(id: task.id)
            undo = UndoOffer(message: "Deleted \(task.title)") { [weak self] in
                await self?.restore(task.id)
            }
        } catch {
            await refresh()
            message = productivityMessage(error)
        }
    }

    func restore(_ id: String) async {
        do {
            let restored = try await service.restore(id: id)
            deleted.removeAll { $0.id == id }
            if !tasks.contains(where: { $0.id == id }) {
                tasks.append(restored)
                tasks.sort { $0.orderKey < $1.orderKey }
            }
        } catch {
            message = productivityMessage(error)
        }
    }

    private func replace(_ task: TaskItem) {
        if detailTargets[task.id] != nil { detailTargets[task.id] = task }
        guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[index] = task
    }
}

// One task's checklist and whether the person follows it.
@MainActor @Observable final class TaskDetailModel {
    private(set) var items: [TaskItem] = []
    private(set) var phase: LoadPhase = .loading
    private(set) var isFollowing = false
    private(set) var followReady = false
    private(set) var me: String?
    var draft = ""
    var message: String?

    private let taskID: String
    private let service: TasksService

    init(taskID: String, service: TasksService) {
        self.taskID = taskID
        self.service = service
    }

    func load() async {
        do {
            items = try await service.items(taskID: taskID)
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            phase = .failed(apiError(error))
        }
        do {
            if let me = try await service.selfUserID() {
                self.me = me
                isFollowing = try await service.followers(taskID: taskID).contains(me)
                followReady = true
            }
        } catch {
            followReady = false
        }
    }

    func setFollowing(_ following: Bool) async {
        guard let me else { return }
        let previous = isFollowing
        isFollowing = following
        do {
            try await service.setFollowing(taskID: taskID, userID: me, following: following)
        } catch {
            isFollowing = previous
            message = productivityMessage(error)
        }
    }

    func add() async {
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        do {
            items.append(try await service.addItem(taskID: taskID, title: String(title.prefix(200))))
            draft = ""
        } catch {
            message = productivityMessage(error)
        }
    }

    func toggle(_ item: TaskItem) async {
        var optimistic = item
        optimistic.status = item.status.toggled
        replace(optimistic)
        do {
            replace(try await service.update(id: item.id, revision: item.revision, changes: TaskChanges(status: optimistic.status)))
        } catch {
            replace(item)
            await failed(error)
        }
    }

    func remove(_ item: TaskItem) async {
        let before = items
        items.removeAll { $0.id == item.id }
        do {
            try await service.delete(id: item.id)
        } catch {
            items = before
            message = productivityMessage(error)
        }
    }

    func canMove(_ item: TaskItem, by offset: Int) -> Bool {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return false }
        return items.indices.contains(index + offset)
    }

    // One place up (-1) or down (1).
    func move(_ item: TaskItem, by offset: Int) async {
        guard let index = items.firstIndex(where: { $0.id == item.id }), items.indices.contains(index + offset) else { return }
        let before = items
        let neighbour = items[index + offset]
        items.swapAt(index, index + offset)
        do {
            let moved = try await service.moveItem(taskID: taskID, itemID: item.id, revision: item.revision, move: offset < 0 ? .before(neighbour.id) : .after(neighbour.id))
            replace(moved)
        } catch {
            items = before
            await failed(error)
        }
    }

    private func failed(_ error: Error) async {
        if error is RevisionConflict { await load() }
        message = productivityMessage(error)
    }

    private func replace(_ item: TaskItem) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index] = item
    }
}
