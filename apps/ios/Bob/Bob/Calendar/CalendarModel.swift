import BobKit
import Foundation
import Observation

// The Calendar tab's state. Held by the shell's store, so the month and the day survive switching tabs.
@MainActor @Observable final class CalendarModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var month: String
    private(set) var loadedMonth: String?
    private(set) var selectedDay: String
    private(set) var byDay: [String: [CalendarEntry]] = [:]
    private(set) var spaces: [SpaceSummary] = []
    private(set) var me: String?
    private(set) var unavailableSpaces: [String] = []
    private(set) var eventsUnavailable = false
    private(set) var googleNotice: AgendaPage.GoogleNotice = .none
    var message: String?
    var undo: UndoOffer?
    var sheet: CalendarSheet?
    var eventTarget: CalendarEventTarget? {
        get {
            if case .target(let target) = sheet { return target }
            return nil
        }
        set { sheet = newValue.map { .target($0) } }
    }

    let service: CalendarService
    let tasks: TasksModel
    let reminders: RemindersModel
    let zone = TimeZone.current.identifier
    private var loadID = 0

    init(service: CalendarService, tasks: TasksModel, reminders: RemindersModel) {
        self.service = service
        self.tasks = tasks
        self.reminders = reminders
        let today = WallClock.day(Date(), zone: zone)
        selectedDay = today
        month = CalendarDays.month(of: today)
    }

    var today: String { WallClock.day(Date(), zone: zone) }
    var selectedEntries: [CalendarEntry] { byDay[selectedDay] ?? [] }

    // Spaces a new event can go in; the private one comes first, as it's the default.
    var writableSpaces: [SpaceSummary] {
        spaces.filter { $0.archivedAt == nil }.sorted { $0.kind == .private && $1.kind != .private }
    }

    // Only the days that hold something, for the week after the selected day.
    var comingUp: [(day: String, entries: [CalendarEntry])] {
        (1...CalendarRules.comingUpDays).compactMap { offset in
            let day = CalendarDays.add(offset, to: selectedDay)
            guard let entries = byDay[day], !entries.isEmpty else { return nil }
            return (day, entries)
        }
    }

    func hasItems(_ day: String) -> Bool { !(byDay[day] ?? []).isEmpty }

    func select(_ day: String) {
        selectedDay = day
        month = CalendarDays.month(of: day)
    }

    // The selection moves too: the old day isn't in the new month's window, so it would read as empty.
    func moveMonth(_ months: Int) {
        select(CalendarDays.openingDay(of: CalendarDays.addMonths(months, to: month), today: today))
    }

    func goToToday() {
        select(today)
    }

    // One space that can't be read costs only that space, and failed events cost only the events: each says so.
    func refresh() async {
        loadID += 1
        let id = loadID
        let shownMonth = month
        guard let window = CalendarDays.loadWindow(month: shownMonth, comingUpDays: CalendarRules.comingUpDays, zone: zone) else { return }
        do {
            let spaces = try await service.spaces()
            async let page = try? service.agenda(from: window.from, to: window.to)
            async let me = try? service.selfUserID()
            let loaded = await loadSpaces(spaces)
            let agenda = await page
            let person = await me
            guard id == loadID, !Task.isCancelled else { return }
            self.spaces = spaces
            self.me = person ?? nil
            byDay = CalendarRules.entries(page: agenda, tasks: loaded.tasks, reminders: loaded.reminders, spaces: spaces, days: window.days, me: self.me, now: Date(), zone: zone)
            unavailableSpaces = loaded.failed
            eventsUnavailable = agenda == nil
            googleNotice = agenda?.googleNotice ?? .none
            loadedMonth = shownMonth
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard id == loadID else { return }
            if phase == .loaded, loadedMonth == shownMonth {
                message = productivityMessage(error)
            } else {
                phase = .failed(apiError(error))
            }
        }
    }

    private func loadSpaces(_ spaces: [SpaceSummary]) async -> (tasks: [(SpaceSummary, [TaskItem])], reminders: [(SpaceSummary, [Reminder])], failed: [String]) {
        let service = service
        return await withTaskGroup(of: (Int, [TaskItem]?, [Reminder]?).self) { group in
            for (index, space) in spaces.enumerated() {
                group.addTask {
                    async let tasks = try? service.tasks(spaceID: space.id)
                    async let reminders = try? service.reminders(spaceID: space.id)
                    return (index, await tasks, await reminders)
                }
            }
            var tasks: [(SpaceSummary, [TaskItem])] = []
            var reminders: [(SpaceSummary, [Reminder])] = []
            var failedIndexes: [Int] = []
            for await (index, spaceTasks, spaceReminders) in group {
                tasks.append((spaces[index], spaceTasks ?? []))
                reminders.append((spaces[index], spaceReminders ?? []))
                if spaceTasks == nil || spaceReminders == nil { failedIndexes.append(index) }
            }
            return (tasks, reminders, failedIndexes.sorted().map { spaces[$0].name })
        }
    }

    func complete(_ task: TaskItem) async {
        do {
            let done = try await tasks.service.update(id: task.id, revision: task.revision, changes: TaskChanges(status: .completed))
            undo = UndoOffer(message: "Completed \(task.title)") { [weak self] in
                guard let self else { return }
                do {
                    _ = try await self.tasks.service.update(id: done.id, revision: done.revision, changes: TaskChanges(status: .open))
                } catch {
                    self.message = "The task could not be reopened."
                }
                await self.refresh()
            }
        } catch is RevisionConflict {
            message = "This task changed elsewhere. The list has been refreshed."
        } catch {
            message = productivityMessage(error)
        }
        await refresh()
    }

    func snooze(_ reminder: Reminder, choice: SnoozeChoice) async {
        guard reminder.rule == nil else { return }
        let zone = reminder.dueZone ?? zone
        do {
            _ = try await reminders.service.update(id: reminder.id, changes: ReminderChanges(due: ReminderDue(at: choice.until, zone: zone)))
            if let previous = reminder.dueAt {
                undo = UndoOffer(message: "Snoozed until \(ProductivityText.moment(choice.until, zone: zone))") { [weak self] in
                    guard let self else { return }
                    do {
                        _ = try await self.reminders.service.update(id: reminder.id, changes: ReminderChanges(due: ReminderDue(at: previous, zone: zone)))
                    } catch {
                        self.message = "The snooze could not be undone."
                    }
                    await self.refresh()
                }
            }
        } catch {
            message = productivityMessage(error)
        }
        await refresh()
    }

    func isShared(_ reminder: Reminder) -> Bool {
        spaces.first { $0.id == reminder.spaceID }.map { $0.kind != .private } ?? false
    }

    // The server has no "uncancel". Only a private reminder reaches this person alone, so only that one is offered back, as a new one.
    func cancel(_ reminder: Reminder) async {
        do {
            _ = try await reminders.service.cancel(id: reminder.id)
            if !isShared(reminder), let dueAt = reminder.dueAt {
                let due = ReminderDue(at: dueAt, zone: reminder.dueZone ?? zone)
                undo = UndoOffer(message: "Cancelled \(reminder.title)") { [weak self] in
                    guard let self else { return }
                    do {
                        _ = try await self.reminders.service.createPrivate(title: reminder.title, due: due, rule: reminder.rule)
                    } catch {
                        self.message = "The reminder could not be brought back."
                    }
                    await self.refresh()
                }
            }
        } catch {
            message = productivityMessage(error)
        }
        await refresh()
    }
}

// Which sheet the Calendar tab has open.
enum CalendarSheet: Identifiable {
    case target(CalendarEventTarget)
    case newEvent(day: String)
    case editEvent(AgendaItem)
    case viewEvent(AgendaItem)
    case google(GoogleAgendaItem)
    case newTask
    case editTask(TaskItem)
    case newReminder
    case editReminder(Reminder)

    var id: String {
        switch self {
        case .target(let target): "target-\(target.id)"
        case .newEvent: "new-event"
        case .editEvent(let item), .viewEvent(let item): "event-\(item.rowID)"
        case .google(let item): "google-\(item.sourceKey)"
        case .newTask: "new-task"
        case .editTask(let task): "task-\(task.id)"
        case .newReminder: "new-reminder"
        case .editReminder(let reminder): "reminder-\(reminder.id)"
        }
    }
}
