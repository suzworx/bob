import BobKit
import Foundation
import Observation

@MainActor @Observable final class RemindersModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var reminders: [Reminder] = []
    var message: String?
    var undo: UndoOffer?

    let service: RemindersService
    let scope: ScopeModel?

    init(service: RemindersService, scope: ScopeModel? = nil) {
        self.service = service
        self.scope = scope
    }

    func forgetSpace() {
        reminders = []
        phase = .loading
    }

    func groups(now: Date) -> [ProductivityGroup<Reminder>] {
        ReminderRules.groups(reminders, now: now)
    }

    func refresh() async {
        let generation = scope?.generation
        do {
            let found = try await service.reminders()
            guard generation == scope?.generation else { return }
            reminders = found
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            if reminders.isEmpty {
                phase = .failed(apiError(error))
            } else {
                message = productivityMessage(error)
            }
        }
    }

    func create(title: String, due: ReminderDue, rule: ReminderRule?, recipients: [String]? = nil) async throws {
        reminders.append(try await service.create(title: title, due: due, rule: rule, recipients: recipients))
    }

    func update(id: String, changes: ReminderChanges) async throws {
        replace(try await service.update(id: id, changes: changes))
    }

    // Moves a one-off later, offering the old time back.
    func snooze(_ reminder: Reminder, choice: SnoozeChoice) async {
        guard reminder.rule == nil else { return }
        let zone = reminder.dueZone ?? TimeZone.current.identifier
        do {
            replace(try await service.update(id: reminder.id, changes: ReminderChanges(due: ReminderDue(at: choice.until, zone: zone))))
            guard let previous = reminder.dueAt else { return }
            undo = UndoOffer(message: "Snoozed until \(ProductivityText.moment(choice.until, zone: zone))") { [weak self] in
                guard let self else { return }
                do {
                    self.replace(try await self.service.update(id: reminder.id, changes: ReminderChanges(due: ReminderDue(at: previous, zone: zone))))
                } catch {
                    self.message = productivityMessage(error)
                }
            }
        } catch {
            message = productivityMessage(error)
        }
    }

    // The server has no "uncancel". A private reminder reaches only this person, so Undo brings it back as a new one, as the web does.
    func cancel(_ reminder: Reminder) async {
        do {
            replace(try await service.cancel(id: reminder.id))
            guard let dueAt = reminder.dueAt else { return }
            let due = ReminderDue(at: dueAt, zone: reminder.dueZone ?? TimeZone.current.identifier)
            undo = UndoOffer(message: "Cancelled \(reminder.title)") { [weak self] in
                guard let self else { return }
                do {
                    try await self.create(title: reminder.title, due: due, rule: reminder.rule, recipients: reminder.recipientUserIDs)
                } catch {
                    self.message = productivityMessage(error)
                }
            }
        } catch {
            message = productivityMessage(error)
        }
    }

    private func replace(_ reminder: Reminder) {
        guard let index = reminders.firstIndex(where: { $0.id == reminder.id }) else { return }
        reminders[index] = reminder
    }
}
